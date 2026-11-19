import type { ResumeState, SessionRecord } from '../domain/SessionRecord';

export interface KeyValueStore {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}

const SESSION_RECORDS_KEY = 'hermesGateway.sessionRecords.v1';
const DEFAULT_MAX_RECORDS_PER_REPOSITORY = 50;

export class SessionRegistry {
  public constructor(
    private readonly store: KeyValueStore,
    private readonly maxRecordsPerRepository = DEFAULT_MAX_RECORDS_PER_REPOSITORY
  ) {}

  public async upsert(record: SessionRecord): Promise<void> {
    const existingRecords = this.readRecords();
    const recordsWithoutCurrent = existingRecords.filter(
      (existingRecord) => !(existingRecord.agentKind === record.agentKind && existingRecord.sessionId === record.sessionId)
    );

    await this.writeRecords([...recordsWithoutCurrent, record]);
  }

  public async getMostRecent(repositoryId: string): Promise<SessionRecord | undefined> {
    return this.list(repositoryId).at(0);
  }

  public list(repositoryId: string): SessionRecord[] {
    return this.readRecords()
      .filter((record) => record.repositoryId === repositoryId)
      .sort(compareByMostRecent);
  }

  public async markResumeFailed(sessionId: string): Promise<void> {
    await this.updateResumeState(sessionId, 'resume-failed');
  }

  public async touch(sessionId: string, lastActiveAt: string): Promise<void> {
    const records = this.readRecords().map((record) =>
      record.sessionId === sessionId ? { ...record, lastActiveAt } : record
    );
    await this.writeRecords(records);
  }

  public async setTitle(sessionId: string, title: string | undefined): Promise<void> {
    const records = this.readRecords().map((record) =>
      record.sessionId === sessionId ? { ...record, title } : record
    );
    await this.writeRecords(records);
  }

  private async updateResumeState(sessionId: string, resumeState: ResumeState): Promise<void> {
    const records = this.readRecords().map((record) =>
      record.sessionId === sessionId ? { ...record, resumeState } : record
    );
    await this.writeRecords(records);
  }

  private readRecords(): SessionRecord[] {
    return this.store.get<SessionRecord[]>(SESSION_RECORDS_KEY, []) ?? [];
  }

  private async writeRecords(records: SessionRecord[]): Promise<void> {
    const retainedRecords = retainNewestRecordsPerRepository(records, this.maxRecordsPerRepository);
    await this.store.update(SESSION_RECORDS_KEY, retainedRecords);
  }
}

function compareByMostRecent(left: SessionRecord, right: SessionRecord): number {
  return right.lastActiveAt.localeCompare(left.lastActiveAt) || right.createdAt.localeCompare(left.createdAt);
}

function retainNewestRecordsPerRepository(records: SessionRecord[], maxRecordsPerRepository: number): SessionRecord[] {
  const recordsByRepository = new Map<string, SessionRecord[]>();

  for (const record of records) {
    const repositoryRecords = recordsByRepository.get(record.repositoryId) ?? [];
    repositoryRecords.push(record);
    recordsByRepository.set(record.repositoryId, repositoryRecords);
  }

  return [...recordsByRepository.values()].flatMap((repositoryRecords) =>
    repositoryRecords.sort(compareByMostRecent).slice(0, maxRecordsPerRepository)
  );
}
