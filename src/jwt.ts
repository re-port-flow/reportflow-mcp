// アクセストークン (JWT) の payload 読み出し。
//
// 署名は検証しない。トークンは Re:port Flow の認可サーバーが発行し、実際の
// 検証は上流 API 側で行われる。ここが読むのは workspace_id のような
// 表示・計測目的のクレームだけなので、壊れたトークンは null に落とす。
//
// auth.ts と telemetry/workspace.ts の両方から使うため独立モジュールに置く
// （auth.ts に置くと telemetry → auth → telemetry の循環 import になる）。

export type JwtPayload = {
  workspace_id?: string;
};

export const decodeJwtPayload = (jwt: string): JwtPayload | null => {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
};
