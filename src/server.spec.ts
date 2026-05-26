import { contentDtoSchema } from './server';

describe('contentDtoSchema (PRJ-3-358)', () => {
  const baseValid = {
    fileName: 'invoice.pdf',
    params: { customerName: '山田太郎' },
  };

  describe('shareType (request)', () => {
    it.each(['01', '02', '03'] as const)(
      'accepts valid code value %s (developer-docs / content-service openapi)',
      (code) => {
        const result = contentDtoSchema.safeParse({
          ...baseValid,
          shareType: code,
        });
        expect(result.success).toBe(true);
      },
    );

    it("defaults to '01' when shareType is omitted", () => {
      const data = contentDtoSchema.parse(baseValid);
      expect(data.shareType).toBe('01');
    });

    it.each([
      'private',
      'public',
      'workspace',
      'invited',
      '04',
      '00',
      '',
    ] as const)('rejects out-of-spec value %s', (value) => {
      const result = contentDtoSchema.safeParse({
        ...baseValid,
        shareType: value,
      });
      expect(result.success).toBe(false);
    });
  });
});
