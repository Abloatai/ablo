import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useSyncStatus } from '@abloatai/ablo/react';
import { AbloProvider, createClient, post, useAblo, usePresence } from './client.js';

function Conversation({ id, account }: { id: string; account: string }) {
  const sessions = usePresence(client => client.conversations, id);
  const { data: row, claimed } = useAblo(client => client.conversations, id);
  const people = new Set(sessions.filter(s => s.participant.kind === 'user').map(s => s.participant.id));
  return <section>
    <h2>{row?.title}</h2>
    <form onSubmit={event => {
      event.preventDefault();
      const title = new FormData(event.currentTarget).get('title');
      void post(`/api/accounts/${account}/rename`, { id, title }).catch(alert);
    }}>
      <label>Chat title <input name="title" defaultValue={row?.title} /></label>
      <button>Rename chat</button>
    </form>
    <p data-testid="people">{people.size} people, {sessions.length} sessions</p>
    <p>{claimed ? 'Agent owns this chat' : 'Unclaimed'}</p>
    <p>Execution: {row?.executionState ?? 'idle'}</p>
    <button onClick={() => { void post(`/api/accounts/${account}/agent`, { id }).catch(alert); }}>Run agent</button>
  </section>;
}
function ConnectedWorkspace({ account }: { account: string }) {
  const rows = useAblo(client => client.conversations.local.list()) ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  return <>
    <button onClick={() => { void post(`/api/accounts/${account}/create`).catch(alert); }}>New chat</button>
    <nav>{rows.map(row => <button data-testid={`conversation-${row.id}`} key={row.id} onClick={() => setSelected(row.id)}>{row.title}</button>)}</nav>
    <button onClick={() => setSelected(null)}>Leave chat</button>
    {selected && <Conversation key={selected} id={selected} account={account} />}
  </>;
}
function Workspace({ account }: { account: string }) {
  const status = useSyncStatus();
  const [connected, setConnected] = useState(false);
  useEffect(() => { if (status.name === 'connected') setConnected(true); }, [status.name]);
  return <>
    <p role="status">{status.name === 'initial' || status.name === 'connecting' ? 'Connecting…' : status.name}</p>
    {(connected || status.name === 'connected') && <ConnectedWorkspace account={account} />}
  </>;
}
function Account({ account }: { account: string }) {
  const [client, setClient] = useState<ReturnType<typeof createClient> | null>(null);
  useEffect(() => {
    const next = createClient(account);
    setClient(next);
    return () => { void next.dispose().catch(console.error); };
  }, [account]);
  return client && <AbloProvider client={client} fallback="passthrough"><Workspace account={account} /></AbloProvider>;
}
function App() {
  const [user, setUser] = useState('');
  const [account, setAccount] = useState('alpha');
  const [error, setError] = useState('');
  return <main style={{ fontFamily: 'system-ui', maxWidth: 800, margin: '3rem auto' }}>
    <h1>Account multiplayer</h1>
    {!user ? <form onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const name = String(form.get('user'));
      void post('/api/login', { user: name, password: form.get('password') }).then(() => {
        setAccount(name === 'eve' ? 'beta' : 'alpha'); setUser(name);
      }).catch(e => setError(String(e)));
    }}>
      <label>User <select name="user"><option>alice</option><option>bob</option><option>eve</option></select></label>
      <label>Password <input name="password" type="password" /></label><button>Sign in</button>
      <p role="alert">{error}</p>
    </form> : <>
      <p>Signed in as {user}</p>
      <label>Account <select value={account} onChange={e => setAccount(e.target.value)}>
        <option>alpha</option><option>beta</option>
      </select></label>
      <Account key={`${user}:${account}`} account={account} />
    </>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
