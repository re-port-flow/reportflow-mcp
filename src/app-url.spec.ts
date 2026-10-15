import { getAppBaseUrl, templatePageUrl } from './app-url';

describe('app-url', () => {
  const original = process.env['REPORTFLOW_AUTH_URL'];
  afterEach(() => {
    if (original === undefined) delete process.env['REPORTFLOW_AUTH_URL'];
    else process.env['REPORTFLOW_AUTH_URL'] = original;
  });

  describe('getAppBaseUrl', () => {
    it('本番: OAuth issuer（https://re-port-flow.com/api/v1）のオリジンを返す', () => {
      delete process.env['REPORTFLOW_AUTH_URL'];
      expect(getAppBaseUrl()).toBe('https://re-port-flow.com');
    });

    it('staging: issuer を差し替えると、そのオリジン（本番のホストではない）を返す', () => {
      process.env['REPORTFLOW_AUTH_URL'] =
        'https://stg.re-port-flow.com/api/v1/';
      expect(getAppBaseUrl()).toBe('https://stg.re-port-flow.com');
    });
  });

  describe('templatePageUrl', () => {
    beforeEach(() => {
      delete process.env['REPORTFLOW_AUTH_URL'];
    });

    it('ワークスペースとバージョンが分かればエディタ画面 /{ws}/templates/{id}/{version}', () => {
      expect(templatePageUrl('ws-1', 'design-1', 3)).toBe(
        'https://re-port-flow.com/ws-1/templates/design-1/3',
      );
    });

    it('対: 旧ルート /design/ や、ルートに存在しない /designs/ を返さない', () => {
      const url = templatePageUrl('ws-1', 'design-1', 3);
      expect(url).not.toContain('/design/');
      expect(url).not.toContain('/designs/');
    });

    it('バージョンが分からなければテンプレート一覧 /{ws}/templates', () => {
      expect(templatePageUrl('ws-1', 'design-1', undefined)).toBe(
        'https://re-port-flow.com/ws-1/templates',
      );
    });

    it('バージョンが整数でなければ、推測せずテンプレート一覧', () => {
      expect(templatePageUrl('ws-1', 'design-1', Number.NaN)).toBe(
        'https://re-port-flow.com/ws-1/templates',
      );
    });

    it('ID が空ならテンプレート一覧', () => {
      expect(templatePageUrl('ws-1', '', 3)).toBe(
        'https://re-port-flow.com/ws-1/templates',
      );
    });

    it('ワークスペースが分からなければアプリのトップ（別のワークスペースを推測しない）', () => {
      expect(templatePageUrl(undefined, 'design-1', 3)).toBe(
        'https://re-port-flow.com/',
      );
      expect(templatePageUrl('', 'design-1', 3)).toBe(
        'https://re-port-flow.com/',
      );
    });

    it('ID に区切り文字が入っていてもパスを壊さない（エンコードする）', () => {
      expect(templatePageUrl('ws/1', 'a b?c', 1)).toBe(
        'https://re-port-flow.com/ws%2F1/templates/a%20b%3Fc/1',
      );
    });
  });
});
