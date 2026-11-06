import { useEffect, useState } from 'react';
import { DatePicker } from './DatePicker';
import { DUE_EVENT, type DueRequest } from './taskChips';

// El calendario que se abre al pulsar la fecha de una tarea en el texto de
// una nota. Uno solo para toda la app: lo pide la ficha con un evento.
export function DueChipPicker() {
  const [req, setReq] = useState<DueRequest | null>(null);
  useEffect(() => {
    const on = (e: Event) => setReq((e as CustomEvent<DueRequest>).detail);
    window.addEventListener(DUE_EVENT, on);
    return () => window.removeEventListener(DUE_EVENT, on);
  }, []);
  if (!req) return null;
  const close = () => setReq(null);
  return (
    <DatePicker
      standalone
      value={req.date}
      onChange={(v) => {
        req.set(v);
        close();
      }}
      onClose={close}
    />
  );
}
