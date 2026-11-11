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

export class FirestoreSessionService extends BaseSessionService {
  constructor(private readonly db: Firestore) {
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
  }: CreateSessionRequest): Promise<Session> {
    const session = createSession({
      id: sessionId?.trim() || crypto.randomUUID(),
      appName,
      userId,
      state: state ? trimTempState(state) : undefined,
      events: [],
      lastUpdateTime: Date.now(),
    });

    await this.ref({ appName, userId, sessionId: session.id }).set({
      sessionId: session.id,
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
  }: GetSessionRequest): Promise<Session | undefined> {
    const ref = this.ref({ appName, userId, sessionId });
    const snapshot = await ref.get();
    if (!snapshot.exists) return undefined;

    const eventDocs = await ref.collection(EVENTS).orderBy("seq").get();
    let events = eventDocs.docs.map((doc) => JSON.parse(doc.get("json")) as Event);
    if (config?.numRecentEvents) events = events.slice(-config.numRecentEvents);
    const { afterTimestamp } = config ?? {};
    if (afterTimestamp) events = events.filter((e) => e.timestamp >= afterTimestamp);

    return createSession({
      id: sessionId,
      appName,
      userId,
      state: snapshot.get("state"),
      events,
      lastUpdateTime: snapshot.get("lastUpdateTime"),
    });
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
      createSession({
        id: doc.get("sessionId"),
        appName: doc.get("appName"),
        userId: doc.get("userId"),
        state: {},
        events: [],
        lastUpdateTime: doc.get("lastUpdateTime"),
      }),
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
    batch.update(ref, { state: session.state, lastUpdateTime: session.lastUpdateTime });
    await batch.commit();

    return appended;
  }
}
