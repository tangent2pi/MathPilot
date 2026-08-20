import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";

export function BackButton({ fallback, label = "返回上一级" }: { fallback: string; label?: string }) {
  const navigate = useNavigate();
  return <button className="back-button" type="button" onClick={() => {
    const index = Number(window.history.state?.idx ?? 0);
    if (index > 0) navigate(-1);
    else navigate(fallback);
  }}><ArrowLeft aria-hidden="true" />{label}</button>;
}
