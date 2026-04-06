'use client';

import { useState } from 'react';

export function RetryProvisionButton() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleRetry() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/tenants/retry', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setResult('Provisioning triggered! Refreshing...');
        setTimeout(() => window.location.reload(), 2000);
      } else {
        setResult(`Error: ${data.error}`);
      }
    } catch {
      setResult('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2">
      <button
        onClick={handleRetry}
        disabled={loading}
        className="px-3 py-1 text-sm bg-yellow-600 text-white rounded hover:bg-yellow-700 disabled:opacity-50"
      >
        {loading ? 'Retrying...' : 'Retry Provisioning'}
      </button>
      {result && <p className="text-xs mt-1">{result}</p>}
    </div>
  );
}
