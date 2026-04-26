// Test environment defaults — individual specs override as needed.
// 既定は Public client (CLIENT_SECRET 未設定)。Confidential テストでは spec 側で個別セット。
process.env['REPORTFLOW_API_BASE_URL'] = 'http://localhost:3002';
process.env['REPORTFLOW_AUTH_URL'] = 'http://localhost:3000/api/v1';
process.env['REPORTFLOW_CLIENT_ID'] = 'test-client';
process.env['REPORTFLOW_TOKEN_STORE'] = 'file';
