import { Node } from "@tiptap/core";

function cells(value: string): string[][] {
  return value
    .split("\n")
    .map((row) => row.split("|").map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean));
}

export const StatTable = Node.create({
  name: "statTable",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      columns: {
        default: "GDP|Population",
        parseHTML: (element) => element.getAttribute("data-columns") || "GDP|Population",
      },
      rows: {
        default: "Cowboy City|900|12000",
        parseHTML: (element) => element.getAttribute("data-rows") || "",
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-stat-table]" }];
  },
  renderHTML({ node }) {
    const columns = String(node.attrs.columns || "")
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    const rows = cells(String(node.attrs.rows || ""));
    return [
      "div",
      {
        "data-stat-table": "true",
        "data-columns": node.attrs.columns,
        "data-rows": node.attrs.rows,
        class: "stat-table-block",
      },
      [
        "table",
        { class: "stat-table" },
        ["thead", ["tr", ...columns.map((column) => ["th", column])]],
        ["tbody", ...rows.map((row) => ["tr", ...row.map((cell) => ["td", cell])])],
      ],
    ];
  },
});
