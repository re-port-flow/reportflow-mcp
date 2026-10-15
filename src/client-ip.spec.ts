import {
  REPORTFLOW_CONNECTING_IP_HEADER,
  stampConnectingIp,
} from './client-ip';

describe('stampConnectingIp', () => {
  it('エッジの CF-Connecting-IP で専用ヘッダを上書きする', () => {
    const headers = new Headers();
    headers.set('cf-connecting-ip', ' 203.0.113.8 ');
    headers.set(REPORTFLOW_CONNECTING_IP_HEADER, '198.51.100.1');
    stampConnectingIp(headers);
    expect(headers.get(REPORTFLOW_CONNECTING_IP_HEADER)).toBe('203.0.113.8');
  });

  it('CF-Connecting-IP が無いときはクライアントの専用ヘッダを消す', () => {
    const headers = new Headers();
    headers.set(REPORTFLOW_CONNECTING_IP_HEADER, '198.51.100.1');
    stampConnectingIp(headers);
    expect(headers.get(REPORTFLOW_CONNECTING_IP_HEADER)).toBeNull();
  });
});
