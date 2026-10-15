import { listProjects } from '../projects';

afterEach(() => jest.restoreAllMocks());

it.each(['', 'sk_runtime', 'pk_public'])('does not send project-list requests with a non-management key (%s)', async (key) => {
  const fetch = jest.spyOn(globalThis, 'fetch');
  await expect(listProjects(key)).resolves.toEqual({
    ok: false,
    reason: 'project listing requires a management credential (run ablo login)',
  });
  expect(fetch).not.toHaveBeenCalled();
});

it('uses the management credential and preserves server denials', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ code: 'forbidden' }), { status: 403 }),
  );
  await expect(listProjects('mk_fixture', 'https://api.example.com')).resolves.toEqual({
    ok: false, reason: 'forbidden',
  });
  expect(fetch).toHaveBeenCalledWith('https://api.example.com/api/v1/projects', expect.objectContaining({
    headers: expect.objectContaining({ authorization: 'Bearer mk_fixture' }),
  }));
});
