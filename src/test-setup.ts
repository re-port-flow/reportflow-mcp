// Test environment defaults — individual specs override as needed.
process.env['REPORTFLOW_API_BASE_URL'] = 'http://localhost:3002';
process.env['REPORTFLOW_AUTH_URL'] = 'http://localhost:3000/api/v1';
process.env['REPORTFLOW_CLIENT_ID'] = 'test-client';
process.env['REPORTFLOW_CLIENT_SECRET'] = 'test-secret';
process.env['REPORTFLOW_TOKEN_STORE'] = 'file';
