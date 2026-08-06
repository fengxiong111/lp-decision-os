import type { ReactNode } from "react";

type DisplayValueProps = {
  value: number | string | null;
  missing: string;
  format?: (value: number | string) => ReactNode;
  className?: string;
};

/** UI boundary for the same three-state contract used by the API layer. */
export function DisplayValue({ value, missing, format, className }: DisplayValueProps) {
  const isMissing = value === null;
  return <span className={className} data-display-state={isMissing ? "waiting" : "value"}>{isMissing ? missing : format ? format(value) : String(value)}</span>;
}
