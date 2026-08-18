'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) router.push(params.get('next') || '/');
    else setError((await res.json().catch(() => ({}))).message || 'Sign-in failed.');
    setBusy(false);
  }

  return (
    <div className="login-wrap">
      <div className="eyebrow">Private workspace</div>
      <h1>HR Automation</h1>
      <p className="page-sub">Enter the team password to continue.</p>
      <form onSubmit={submit}>
        <input
          type="password" value={password} autoFocus autoComplete="current-password"
          placeholder="Password" onChange={(e) => setPassword(e.target.value)}
        />
        {error ? <div className="banner danger"><div>{error}</div></div> : null}
        <button className="primary" type="submit" disabled={busy || !password}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense fallback={null}><LoginForm /></Suspense>;
}
