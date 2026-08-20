import { LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  pending?: boolean;
  pendingLabel?: string;
  children: ReactNode;
};

export function AsyncButton({ pending = false, pendingLabel = "处理中…", children, disabled, className = "", ...props }: Props) {
  return (
    <button {...props} className={`btn ${className}`.trim()} disabled={disabled || pending} aria-busy={pending}>
      {pending ? <><LoaderCircle className="button-spinner" aria-hidden="true" />{pendingLabel}</> : children}
    </button>
  );
}
