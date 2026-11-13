import type { Firestore } from "@google-cloud/firestore";
import {
  BaseSessionService,
  createSession,
  trimTempState,
  type AppendEventRequest,
  type CompositeSessionKey,
  type CreateSessionRequest,
  type DeleteSessionRequest,
  type Event,
  type GetSessionRequest,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type Session,
} from "@google/adk";

const SESSIONS = "sessions";
const EVENTS = "events";
// A run holds the session until its lease lapses; every persisted event renews it.
export const RUN_LEASE_MS = 10 * 60_000;
const MAX_RUN_ERROR = 200;

export type RunState = {
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  endedAt?: number;
  error?: string;
};
export class RunInProgressError extends Error {
  constructor() {
    super("A run is already in progress for this session");
    this.name = "RunInProgressError";
  }
}

type RunFields = {
  runStatus?: RunState["status"];
  runStartedAt?: number;
  runEndedAt?: number | null;
  runError?: string | null;
  runLeaseUntil?: number;
};
const isLive = (f: RunFields, now: number) =>
  f.runStatus === "running" && (f.runLeaseUntil ?? 0) > now;

// The run of a session as stored; a run whose lease lapsed is reported as failed.
export const runState = (f: RunFields, now = Date.now()): RunState | undefined => {
  if (!f.runStatus || f.runStartedAt === undefined) return undefined;
  const stalled = f.runStatus === "running" && !isLive(f, now);
  return {
    status: stalled ? "failed" : f.runStatus,
    startedAt: f.runStartedAt,
    ...(stalled
      ? { endedAt: f.runLeaseUntil, error: "The run stopped responding" }
      : {
          ...(f.runEndedAt != null && { endedAt: f.runEndedAt }),
          ...(f.runError != null && { error: f.runError }),
        }),
  };
};
export const runFields = (doc: { get: (field: string) => unknown }): RunFields => ({
  runStatus: doc.get("runStatus") as RunFields["runStatus"],
  runStartedAt: doc.get("runStartedAt") as number | undefined,
  runEndedAt: doc.get("runEndedAt") as number | null | undefined,
  runError: doc.get("runError") as string | null | undefined,
  runLeaseUntil: doc.get("runLeaseUntil") as number | undefined,
});

type TaskSession = Session & { taskId?: string; run?: RunState };
const withMeta = (session: Session, taskId?: string, run?: RunState): TaskSession =>
  Object.assign(session, {
    ...(taskId !== undefined && { taskId }),
    ...(run && { run }),
  });

export class FirestoreSessionService extends BaseSessionService {
  // Sessions this instance runs: a timer renews each lease between events.
  private readonly leased = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly db: Firestore,
    private readonly heartbeatMs = RUN_LEASE_MS / 3,
  ) {
    super();
  }

  private ref({ appName, userId, sessionId }: CompositeSessionKey) {
    const id = [appName, userId, sessionId].map(encodeURIComponent).join(":");
    return this.db.collection(SESSIONS).doc(id);
  }

  override async createSession({
    appName,
    userId,
    state,
    sessionId,
    taskId,
  }: CreateSessionRequest & { taskId?: string }): Promise<TaskSession> {
    const session = withMeta(
      createSession({
        id: sessionId?.trim() || crypto.randomUUID(),
        appName,
        userId,
        state: state ? trimTempState(state) : undefined,
        events: [],
        lastUpdateTime: Date.now(),
      }),
      taskId,
    );

    await this.ref({ appName, userId, sessionId: session.id }).set({
      sessionId: session.id,
      ...(taskId !== undefined && { taskId }),
      appName,
      userId,
      state: session.state,
      lastUpdateTime: session.lastUpdateTime,
    });

    return session;
  }

  override async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<TaskSession | undefined> {
    const ref = this.ref({ appName, userId, sessionId });
    const snapshot = await ref.get();
    if (!snapshot.exists) return undefined;

    const eventDocs = await ref.collection(EVENTS).orderBy("seq").get();
    let events = eventDocs.docs.map((doc) => JSON.parse(doc.get("json")) as Event);
    if (config?.numRecentEvents) events = events.slice(-config.numRecentEvents);
    const { afterTimestamp } = config ?? {};
    if (afterTimestamp) events = events.filter((e) => e.timestamp >= afterTimestamp);

    return withMeta(
      createSession({
        id: sessionId,
        appName,
        userId,
        state: snapshot.get("state"),
        events,
        lastUpdateTime: snapshot.get("lastUpdateTime"),
      }),
      snapshot.get("taskId"),
      runState(runFields(snapshot)),
    );
  }

  override async listSessions({
    appName,
    userId,
    limit,
    offset,
    page,
    order,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    let query = this.db.collection(SESSIONS).where("appName", "==", appName);
    if (userId !== undefined) query = query.where("userId", "==", userId);

    const sessions = (await query.get()).docs.map((doc) =>
      withMeta(
        createSession({
          id: doc.get("sessionId"),
          appName: doc.get("appName"),
          userId: doc.get("userId"),
          state: {},
          events: [],
          lastUpdateTime: doc.get("lastUpdateTime"),
        }),
        doc.get("taskId"),
      ),
    );

    if (order) {
      const sign = order === "asc" ? 1 : -1;
      sessions.sort(
        (a, b) => sign * (a.lastUpdateTime - b.lastUpdateTime) || a.id.localeCompare(b.id),
      );
    }

    const totalItems = sessions.length;
    const start = page !== undefined && limit !== undefined ? (page - 1) * limit : (offset ?? 0);
    if (limit === undefined) {
      return {
        sessions: sessions.slice(start),
        page: 1,
        limit: totalItems,
        totalItems,
        totalPages: totalItems ? 1 : 0,
      };
    }

    return {
      sessions: sessions.slice(start, start + limit),
      page: page ?? (limit === 0 ? 1 : Math.floor(start / limit) + 1),
      limit,
      totalItems,
      totalPages: limit === 0 ? 0 : Math.ceil(totalItems / limit),
    };
  }

  // Takes the session for one run. Fails when another run holds a live lease,
  // so two executions never append to the same session at once.
  async startRun(key: CompositeSessionKey, now = Date.now()): Promise<void> {
    const ref = this.ref(key);
    await this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new Error("Session not found");
      if (isLive(runFields(snapshot), now)) throw new RunInProgressError();
      tx.update(ref, {
        runStatus: "running",
        runStartedAt: now,
        runEndedAt: null,
        runError: null,
        runLeaseUntil: now + RUN_LEASE_MS,
      });
    });
    clearInterval(this.leased.get(key.sessionId));
    const timer = setInterval(() => {
      this.ref(key)
        .update({ runLeaseUntil: Date.now() + RUN_LEASE_MS })
        .catch((err) => console.error("Failed to renew the run lease", err));
    }, this.heartbeatMs);
    timer.unref();
    this.leased.set(key.sessionId, timer);
  }

  async finishRun(key: CompositeSessionKey, error?: string, now = Date.now()): Promise<void> {
    clearInterval(this.leased.get(key.sessionId));
    this.leased.delete(key.sessionId);
    await this.ref(key).update({
      runStatus: error === undefined ? "succeeded" : "failed",
      runEndedAt: now,
      runLeaseUntil: 0,
      // Only the first line is kept: the full error stays in the job log.
      runError: error?.split("\n")[0]?.slice(0, MAX_RUN_ERROR) ?? null,
    });
  }

  override async deleteSession(key: DeleteSessionRequest): Promise<void> {
    const ref = this.ref(key);
    const events = await ref.collection(EVENTS).get();
    const batch = this.db.batch();

    for (const doc of events.docs) batch.delete(doc.ref);
    batch.delete(ref);
    await batch.commit();
  }

  override async appendEvent({ session, event }: AppendEventRequest): Promise<Event> {
    const appended = await super.appendEvent({ session, event });
    if (event.partial) return appended;

    session.lastUpdateTime = appended.timestamp;
    const ref = this.ref({
      appName: session.appName,
      userId: session.userId,
      sessionId: session.id,
    });
    const batch = this.db.batch();

    batch.set(ref.collection(EVENTS).doc(appended.id), {
      seq: session.events.findIndex((e) => e.id === appended.id),
      timestamp: appended.timestamp,
      json: JSON.stringify(appended),
    });
    batch.update(ref, {
      state: session.state,
      lastUpdateTime: session.lastUpdateTime,
      ...(this.leased.has(session.id) && { runLeaseUntil: Date.now() + RUN_LEASE_MS }),
    });
    await batch.commit();

    return appended;
  }
}
