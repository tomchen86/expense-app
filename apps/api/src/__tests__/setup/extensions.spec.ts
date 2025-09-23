import { DataSource } from 'typeorm';
import { ensureRequiredExtensions } from './extensions';

describe('ensureRequiredExtensions', () => {
  it('asks postgres for uuids and citext extensions and returns the installed names', async () => {
    const installedExtensions = [
      { extname: 'uuid-ossp' },
      { extname: 'citext' },
    ];
    const query = jest.fn().mockResolvedValue(installedExtensions);
    const fakeDataSource = { query } as unknown as DataSource;

    await expect(ensureRequiredExtensions(fakeDataSource)).resolves.toEqual(
      expect.arrayContaining(['uuid-ossp', 'citext']),
    );
    expect(query).toHaveBeenCalledWith(
      "SELECT extname FROM pg_extension WHERE extname IN ('uuid-ossp', 'citext')",
    );
  });
});
