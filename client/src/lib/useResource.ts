import { useCallback, useEffect, useState } from 'react';
import { ApiError, request } from './api.js';
import type { RequestOptions } from './api.js';

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
  setData: (next: T) => void;
}

/**
 * Loads a GET endpoint and re-loads when the key changes. The key is a string the
 * caller builds from whatever the request depends on, which keeps the effect from
 * re-running on every render because an options object was recreated.
 */
export function useResource<T>(path: string, options: RequestOptions = {}, key = path): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const audience = options.audience ?? 'staff';
  const query = options.query;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    request<T>(path, { audience, query, signal: controller.signal })
      .then((result) => setData(result))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof ApiError ? err : new ApiError(0, 'network_error', String(err)));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce, audience]);

  return { data, error, loading, reload, setData };
}
