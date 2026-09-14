import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { getToken, onSessionExpired, request, setToken } from '../lib/api.js';
import type { Audience } from '../lib/api.js';
import type { Role } from '../../../lib/types.js';

export interface StaffIdentity {
  kind: 'staff';
  id: number;
  name: string;
  username: string;
  role: Role;
}

export interface SubscriberIdentity {
  kind: 'subscriber';
  id: number;
  name: string;
  code: string;
}

type Identity = StaffIdentity | SubscriberIdentity;

interface AuthValue<T extends Identity> {
  identity: T | null;
  status: 'loading' | 'ready';
  signIn: (token: string, identity: T) => void;
  signOut: () => void;
}

function useAuthState<T extends Identity>(audience: Audience): AuthValue<T> {
  const [identity, setIdentity] = useState<T | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');

  useEffect(() => {
    let cancelled = false;
    if (getToken(audience) === null) {
      setStatus('ready');
      return () => {
        cancelled = true;
      };
    }
    request<T>('/me', { audience })
      .then((me) => {
        if (!cancelled) setIdentity(me);
      })
      .catch(() => {
        if (!cancelled) setIdentity(null);
      })
      .finally(() => {
        if (!cancelled) setStatus('ready');
      });
    return () => {
      cancelled = true;
    };
  }, [audience]);

  // A 401 anywhere in the app clears this audience's session, so an expired token
  // returns the user to their own sign in screen rather than to a broken screen.
  useEffect(
    () =>
      onSessionExpired((expired) => {
        if (expired === audience) setIdentity(null);
      }),
    [audience],
  );

  const signIn = useCallback(
    (token: string, next: T) => {
      setToken(audience, token);
      setIdentity(next);
    },
    [audience],
  );

  const signOut = useCallback(() => {
    setToken(audience, null);
    setIdentity(null);
  }, [audience]);

  return useMemo(
    () => ({ identity, status, signIn, signOut }),
    [identity, status, signIn, signOut],
  );
}

const StaffAuthContext = createContext<AuthValue<StaffIdentity> | null>(null);
const SubscriberAuthContext = createContext<AuthValue<SubscriberIdentity> | null>(null);

export function StaffAuthProvider({ children }: { children: ReactNode }) {
  const value = useAuthState<StaffIdentity>('staff');
  return <StaffAuthContext.Provider value={value}>{children}</StaffAuthContext.Provider>;
}

export function SubscriberAuthProvider({ children }: { children: ReactNode }) {
  const value = useAuthState<SubscriberIdentity>('subscriber');
  return (
    <SubscriberAuthContext.Provider value={value}>{children}</SubscriberAuthContext.Provider>
  );
}

export function useStaffAuth(): AuthValue<StaffIdentity> {
  const value = useContext(StaffAuthContext);
  if (value === null) throw new Error('useStaffAuth must be used inside StaffAuthProvider');
  return value;
}

export function useSubscriberAuth(): AuthValue<SubscriberIdentity> {
  const value = useContext(SubscriberAuthContext);
  if (value === null) {
    throw new Error('useSubscriberAuth must be used inside SubscriberAuthProvider');
  }
  return value;
}

export function isOwner(identity: StaffIdentity | null): boolean {
  return identity?.role === 'owner';
}
