import { ImagePlus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

function keyOf(file: File): string { return `${file.name}\0${file.size}\0${file.lastModified}`; }

function Preview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => { const next = URL.createObjectURL(file); setUrl(next); return () => URL.revokeObjectURL(next); }, [file]);
  return <figure className="image-upload-preview">{url && <img src={url} alt={file.name} width="320" height="240" />}<figcaption><span>{file.name}</span><button type="button" aria-label={`移除 ${file.name}`} onClick={onRemove}><Trash2 aria-hidden="true" /></button></figcaption></figure>;
}

type ImagePickerProps = {
  files: File[];
  onChange: (files: File[]) => void;
  label: string;
  maxFiles?: number;
  maxBytes?: number;
  onReject?: (message: string) => void;
};

export function ImagePicker({ files, onChange, label, maxFiles = 4, maxBytes, onReject }: ImagePickerProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const reject = (message: string) => { setError(message); onReject?.(message); };
  const append = (incoming: File[]) => {
    const seen = new Set(files.map(keyOf));
    const invalidType = incoming.filter((file) => !file.type.startsWith("image/"));
    const oversized = maxBytes ? incoming.filter((file) => file.type.startsWith("image/") && file.size > maxBytes) : [];
    const accepted = incoming.filter((file) => file.type.startsWith("image/") && (!maxBytes || file.size <= maxBytes) && !seen.has(keyOf(file)) && (seen.add(keyOf(file)) || true));
    const remaining = Math.max(0, maxFiles - files.length);
    if (invalidType.length) reject("请选择 PNG、JPEG 或 WebP 图片。");
    else if (oversized.length) reject(`图片不能超过 ${(maxBytes! / 1_048_576).toFixed(1)} MiB。`);
    else if (accepted.length > remaining) reject(`最多可以选择 ${maxFiles} 张图片。`);
    else setError("");
    onChange([...files, ...accepted.slice(0, remaining)]);
  };
  return <section className="image-upload-field" aria-label={`${label}上传区`}>
    <div className="image-upload-actions"><label htmlFor={id} className="file-chip"><ImagePlus aria-hidden="true" />{label}</label><input id={id} ref={input} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => { append([...(event.target.files ?? [])]); event.target.value = ""; }} /><span>{files.length ? `已选择 ${files.length} / ${maxFiles} 张` : `最多 ${maxFiles} 张`}</span>{files.length > 0 && <button className="text-button" type="button" onClick={() => onChange([])}>清空</button>}</div>
    {error && <p className="status-note error image-upload-error" role="alert">{error}</p>}
    {files.length > 0 && <div className="image-upload-grid">{files.map((file) => <Preview key={keyOf(file)} file={file} onRemove={() => onChange(files.filter((item) => keyOf(item) !== keyOf(file)))} />)}</div>}
  </section>;
}
