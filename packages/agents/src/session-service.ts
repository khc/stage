import type { DocumentReference, Firestore, Transaction } from "@google-cloud/firestore";
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

import { modelRefSchema, type ModelRef } from "./model-ref";

const SESSIONS = "sessions";
const EVENTS = "events";
// A run holds the session until its lease lapses; every persisted event renews it.
export const RUN_LEASE_MS = 10 * 60_000;
const MAX_RUN_ERROR = 200;
// The run this instance holds on a session: its id fences every write, its timer renews the lease.
type HeldRun = { runId: string; timer?: ReturnType<typeof setInterval>; lost?: boolean };
// A queued message blocks another one only this long: later it belongs to a job that never started.
const PENDING_TTL_MS = 60_000;

export type RunState = {
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  endedAt?: number;
  error?: string;
};
export class MessageQueuedError extends Error {
  constructor() {
    super("A message for this session is still waiting to be delivered");
    this.name = "MessageQueuedError";
  }
}
// Another run took the session over (the lease lapsed), so this one must stop writing.
export class RunLostError extends Error {
  constructor() {
    super("This run no longer holds the session");
    this.name = "RunLostError";
  }
}
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

const MAX_SESSION_NAME = 120;

export const toSessionName = (prompt: string): string | undefined => {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > MAX_SESSION_NAME
    ? `${normalized.slice(0, MAX_SESSION_NAME - 1).trimEnd()}…`
    : normalized;
};

type TaskSession = Session & { taskId?: string; name?: string; run?: RunState };
const withMeta = (session: Session, taskId?: string, run?: RunState, name?: string): TaskSession =>
  Object.assign(session, {
    ...(taskId !== undefined && { taskId }),
    ...(name !== undefined && { name }),
    ...(run && { run }),
  });

export class FirestoreSessionService extends BaseSessionService {
  // Called after a user message is stored. The ADK runner appends it without
  // yielding it, so this is the only way to tell live subscribers about it.
  onUserEvent?: (event: Event, session: TaskSession) => Promise<void>;

  // Sessions this instance runs: a timer renews each lease between events.
  private readonly leased = new Map<string, HeldRun>();

  private readonly db: Firestore;
  private readonly heartbeatMs: number;

  constructor(db: Firestore, heartbeatMs = RUN_LEASE_MS / 3) {
    super();
    this.db = db;
    this.heartbeatMs = heartbeatMs;
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
    name,
  }: CreateSessionRequest & { taskId?: string; name?: string }): Promise<TaskSession> {
    const cleanName = name ? toSessionName(name) : undefined;
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
      undefined,
      cleanName,
    );

    await this.ref({ appName, userId, sessionId: session.id }).set({
      sessionId: session.id,
      ...(taskId !== undefined && { taskId }),
      ...(cleanName !== undefined && { name: cleanName }),
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
      snapshot.get("name"),
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
        undefined,
        doc.get("name"),
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

  // Stores the next message of a session for the job that resumes it, so the
  // job needs only the session id. Fails while the session runs or another
  // message was queued moments ago. The model, if any, is the one chosen for this message.
  async queueMessage(
    key: CompositeSessionKey,
    message: string,
    { model, now = Date.now() }: { model?: ModelRef; now?: number } = {},
  ) {
    const ref = this.ref(key);
    await this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new Error("Session not found");
      const queuedAt: number | undefined = snapshot.get("pendingMessageAt");
      // Queued means waiting for a job: queued after the last run began, and recently.
      const queued =
        snapshot.get("pendingMessage") != null &&
        (queuedAt ?? 0) > (snapshot.get("runStartedAt") ?? 0) &&
        now - (queuedAt ?? 0) < PENDING_TTL_MS;
      if (isLive(runFields(snapshot), now)) throw new RunInProgressError();
      if (queued) throw new MessageQueuedError();
      tx.update(ref, {
        pendingMessage: message,
        pendingMessageAt: now,
        pendingModel: model ?? null,
      });
    });
  }

  // The app and user a session was created under; undefined for an unknown session.
  async findOwner(sessionId: string): Promise<{ appName: string; userId: string } | undefined> {
    const found = await this.db
      .collection(SESSIONS)
      .where("sessionId", "==", sessionId)
      .limit(1)
      .get();
    const doc = found.docs[0];
    return doc && { appName: doc.get("appName"), userId: doc.get("userId") };
  }

  async pendingMessage(key: CompositeSessionKey): Promise<string | undefined> {
    return (await this.ref(key).get()).get("pendingMessage") ?? undefined;
  }

  // The model chosen for the queued message; undefined when none was chosen.
  async pendingModel(key: CompositeSessionKey): Promise<ModelRef | undefined> {
    const parsed = modelRefSchema.safeParse((await this.ref(key).get()).get("pendingModel"));
    return parsed.success ? parsed.data : undefined;
  }

  async clearMessage(key: CompositeSessionKey): Promise<void> {
    await this.ref(key).update({
      pendingMessage: null,
      pendingMessageAt: null,
      pendingModel: null,
    });
  }

  // Takes the session for one run. Fails when another run holds a live lease,
  // so two executions never append to the same session at once.
  private release(sessionId: string) {
    clearInterval(this.leased.get(sessionId)?.timer);
    this.leased.delete(sessionId);
  }

  // Runs a write inside a transaction that first checks this run still owns the
  // session; a run that lost it (its lease lapsed and another started) gets
  // RunLostError instead of overwriting the newer run.
  private async fenced(
    key: CompositeSessionKey,
    held: HeldRun,
    write: (tx: Transaction, ref: DocumentReference) => void,
  ) {
    const ref = this.ref(key);
    try {
      await this.db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (snapshot.get("runId") !== held.runId) throw new RunLostError();
        write(tx, ref);
      });
    } catch (err) {
      if (err instanceof RunLostError) {
        // Kept in the map, marked lost, so later writes and finishRun stay refused.
        clearInterval(held.timer);
        held.lost = true;
      }
      throw err;
    }
  }

  async startRun(key: CompositeSessionKey, now = Date.now()): Promise<void> {
    const ref = this.ref(key);
    const runId = crypto.randomUUID();
    await this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new Error("Session not found");
      if (isLive(runFields(snapshot), now)) throw new RunInProgressError();
      tx.update(ref, {
        runId,
        runStatus: "running",
        runStartedAt: now,
        runEndedAt: null,
        runError: null,
        runLeaseUntil: now + RUN_LEASE_MS,
      });
    });
    this.release(key.sessionId);
    const held: HeldRun = { runId };
    held.timer = setInterval(() => {
      this.fenced(key, held, (tx, sessionRef) =>
        tx.update(sessionRef, { runLeaseUntil: Date.now() + RUN_LEASE_MS }),
      ).catch((err) => console.error("Failed to renew the run lease", err));
    }, this.heartbeatMs);
    held.timer.unref();
    this.leased.set(key.sessionId, held);
  }

  async finishRun(key: CompositeSessionKey, error?: string, now = Date.now()): Promise<void> {
    const held = this.leased.get(key.sessionId);
    this.release(key.sessionId);
    if (held?.lost) {
      console.error("Not recording the end of a run that lost its session");
      return;
    }
    const result = {
      runStatus: error === undefined ? "succeeded" : "failed",
      runEndedAt: now,
      runLeaseUntil: 0,
      // Only the first line is kept: the full error stays in the job log.
      runError: error?.split("\n")[0]?.slice(0, MAX_RUN_ERROR) ?? null,
      // The queued message is consumed only by a successful run, so a retried task still finds it.
      ...(error === undefined && {
        pendingMessage: null,
        pendingMessageAt: null,
        pendingModel: null,
      }),
    };
    if (!held) return void (await this.ref(key).update(result));
    try {
      await this.fenced(key, held, (tx, sessionRef) => tx.update(sessionRef, result));
    } catch (err) {
      // A run that lost the session must not overwrite the status of the one that took it.
      if (!(err instanceof RunLostError)) throw err;
      console.error("Not recording the end of a run that lost its session");
    }
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
    const eventData = {
      seq: session.events.findIndex((e) => e.id === appended.id),
      timestamp: appended.timestamp,
      json: JSON.stringify(appended),
    };
    const sessionData = {
      state: trimTempState(session.state),
      lastUpdateTime: session.lastUpdateTime,
    };
    const held = this.leased.get(session.id);
    if (held) {
      // While a run holds the session, a write counts only if it still owns it.
      await this.fenced(
        { appName: session.appName, userId: session.userId, sessionId: session.id },
        held,
        (tx, sessionRef) => {
          tx.set(sessionRef.collection(EVENTS).doc(appended.id), eventData);
          tx.update(sessionRef, {
            ...sessionData,
            runLeaseUntil: Date.now() + RUN_LEASE_MS,
          });
        },
      );
    } else {
      const batch = this.db.batch();
      batch.set(ref.collection(EVENTS).doc(appended.id), eventData);
      batch.update(ref, sessionData);
      await batch.commit();
    }
    if (appended.author === "user")
      await this.onUserEvent?.(appended, session as TaskSession).catch((err) =>
        console.error("Failed to publish the user message", err),
      );

    return appended;
  }
}
