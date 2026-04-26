export type TokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  workspaceId?: string;
};

export interface TokenStore {
  load(account: string): Promise<TokenSet | null>;
  save(account: string, tokens: TokenSet): Promise<void>;
  clear(account: string): Promise<void>;
  readonly kind: 'keychain' | 'file';
}

export const TOKEN_STORE_SERVICE = 'reportflow-mcp';
