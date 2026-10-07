import { useEffect, useRef, useState } from "react";
import type { Api } from "./types";

type Request = { lifetime: object; alive: boolean };
type Owner = {
  api: Api;
  native: boolean;
  key: string;
  lifetime: object | null;
  operation: Request | null;
  read: Request | null;
};
export type ExtensionRequest = {
  lifetime: object;
  current: () => boolean;
  finish: () => void;
};

/** One mounted page/API/native/slot owns admission and replies. Changing props
 * creates a new owner even when they later change back. Effect cleanup retires
 * its lifetime; a Strict Mode effect restart gets a different lifetime too. */
export function useExtensionRequestScope(
  api: Api,
  native: boolean,
  key: string,
) {
  const ref = useRef<Owner>({
    api,
    native,
    key,
    lifetime: null,
    operation: null,
    read: null,
  });
  if (
    ref.current.api !== api ||
    ref.current.native !== native ||
    ref.current.key !== key
  )
    ref.current = {
      api,
      native,
      key,
      lifetime: null,
      operation: null,
      read: null,
    };
  const owner = ref.current;
  useEffect(() => {
    const lifetime = {};
    owner.lifetime = lifetime;
    return () => {
      if (owner.lifetime !== lifetime) return;
      owner.lifetime = null;
      owner.operation = null;
      owner.read = null;
    };
  }, [owner]);
  const current = () =>
    ref.current === owner && owner.native && owner.lifetime !== null;
  function begin(kind: "operation" | "read"): ExtensionRequest | null {
    if (!current() || (kind === "operation" && owner.operation)) return null;
    const request: Request = { lifetime: owner.lifetime!, alive: true };
    owner[kind] = request;
    return {
      lifetime: request.lifetime,
      current: () =>
        current() &&
        request.alive &&
        owner.lifetime === request.lifetime &&
        owner[kind] === request,
      finish: () => {
        request.alive = false;
        if (owner[kind] === request) owner[kind] = null;
      },
    };
  }
  return {
    owner,
    current,
    busy: () => owner.operation !== null,
    ownsLifetime: (lifetime: object) =>
      current() && owner.lifetime === lifetime,
    beginOperation: () => begin("operation"),
    beginRead: () => begin("read"),
    retireOperation: () => {
      owner.operation = null;
      owner.read = null;
    },
  };
}

/** Hide the old page's model immediately on a prop change, before passive
 * effects run. The ref also gives saved handlers current dialog/grant identity
 * before React has rendered a synchronous close, toggle or admission change. */
export function useExtensionView<T extends object>(owner: object, initial: T) {
  const [state, setState] = useState({ owner, value: initial });
  const ref = useRef(state);
  if (ref.current.owner !== owner) ref.current = { owner, value: initial };
  return {
    value: ref.current.value,
    current: () => (ref.current.owner === owner ? ref.current.value : null),
    update: (patch: Partial<T>) => {
      if (ref.current.owner !== owner) return;
      ref.current = { owner, value: { ...ref.current.value, ...patch } };
      setState(ref.current);
    },
  };
}
