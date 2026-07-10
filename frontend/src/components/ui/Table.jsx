import { cx } from "./cx.js";

function Table({ className, children }) {
  return (
    <div className="glass overflow-x-auto rounded-card">
      <table className={cx("w-full text-sm", className)}>{children}</table>
    </div>
  );
}

function Th({ className, children }) {
  return (
    <th className={cx("border-b border-glass-border-strong px-3 py-2 text-left text-label uppercase text-mist/50", className)}>
      {children}
    </th>
  );
}

function Tr({ className, children, ...props }) {
  return (
    <tr className={cx("border-b border-glass-border last:border-0 hover:bg-glass-hover", className)} {...props}>
      {children}
    </tr>
  );
}

function Td({ className, mono = false, children }) {
  return <td className={cx("px-3 py-2.5", mono && "font-mono text-[13px] tabular-nums", className)}>{children}</td>;
}

Table.Th = Th;
Table.Tr = Tr;
Table.Td = Td;

export default Table;
