export function Stat({ label, value, title }: { label: string; value: string | number; title?: string }) {
  return (
    <div className="stat" title={title}>
      <span className="v">{value}</span>
      <span className="l">{label}</span>
    </div>
  )
}
