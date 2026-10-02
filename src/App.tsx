import { useEffect, useState } from 'react'

function App() {
  const [status, setStatus] = useState('checking…')

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json() as Promise<{ ok: boolean }>)
      .then((data) => setStatus(data.ok ? 'api online' : 'api unhappy'))
      .catch(() => setStatus('api offline'))
  }, [])

  return (
    <main>
      <h1>crownshy press</h1>
      <p>a coworking space for two. coming soon.</p>
      <p className="status mono">{status}</p>
    </main>
  )
}

export default App
