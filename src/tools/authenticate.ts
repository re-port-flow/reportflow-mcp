import { authorize } from '../auth.js';

export const authenticateTool = {
  name: 'authenticate',
  description:
    'ReportFlow への OAuth2 認証を行います。ブラウザが起動し、ログイン・ワークスペース選択・consent を経てトークンを keychain (または XDG file) に保存します。他のツールが認証エラーを返したら、まずこのツールを呼んでください。force=true で既存トークンを破棄して再認証します。',
};

export type AuthenticateInput = {
  force?: boolean;
};

export type AuthenticateResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export const handleAuthenticate = async (
  input: AuthenticateInput,
): Promise<AuthenticateResult> => {
  try {
    const result = await authorize({ force: input.force === true });
    const expiresIn = Math.max(
      0,
      Math.floor((result.expiresAt - Date.now()) / 1000),
    );
    const lines = [
      '✅ 認証完了',
      `scope: ${result.scope}`,
      `expires_in: ${expiresIn}s`,
    ];
    if (result.workspaceId) {
      lines.push(`workspace_id: ${result.workspaceId}`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `認証失敗: ${message}` }],
      isError: true,
    };
  }
};
