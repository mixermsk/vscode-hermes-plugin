export type RepositoryIdentity = Readonly<{
  logicalId: string;
  gitRoot: string;
  cwd: string;
  remoteOrigin?: string;
  branch?: string;
}>;

export type RepositoryResolution =
  | Readonly<{
      kind: 'repository';
      identity: RepositoryIdentity;
    }>
  | Readonly<{
      kind: 'not-a-repository';
      cwd: string;
    }>;
