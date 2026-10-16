# Changelog

## 0.1.0

First public release.

- Graph view for JSON, YAML (including multi-document files), TOML, XML and HTML, with automatic
  layout, pan, zoom and minimap.
- In-place editing: values, add, rename, remove, reorder (drag & drop, Alt+↑/↓) and type changes,
  written back as minimal text edits that keep formatting and comments.
- Search with highlighting and navigation; two-way sync between the graph and the text editor.
- JSON Schema validation and hints for JSON, YAML and TOML; XSD and DTD for XML;
  **Select Schema…** to choose one per file.
- Large-file handling: deep levels collapsed on open, virtualized cards and rows.
- Export the graph as PNG or SVG; expand/collapse all.
