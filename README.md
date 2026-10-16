# Fileblocks

Extensão do VS Code para visualizar e editar arquivos estruturados (JSON, YAML, XML, HTML) como um
grafo de nós em um canvas, no estilo do [JSON Crack](https://jsoncrack.com/editor), com edição direta nos nós.

## Desenvolvimento

```bash
npm install
npm run build      # gera dist/extension.js, dist/webview.js e dist/webview.css
npm run watch      # rebuild automático
npm run typecheck  # checagem de tipos (o esbuild não checa tipos)
npm test           # testes unitários dos adapters (node:test)
```

Para rodar, aperte **F5** no VS Code. Ele abre uma janela de Extension Development Host com a pasta `samples/`.
Abra um arquivo e use o ícone na barra de título, ou clique com o botão direito no explorer e escolha
**Fileblocks: Open in Block Editor**. O editor está registrado com `priority: "option"`, então ele
não substitui o editor de texto padrão.

## Arquitetura

```
src/
  extension.ts                 ativação, registro do editor e dos comandos
  editor/
    BlockEditorProvider.ts     CustomTextEditorProvider: liga o TextDocument à webview
    webviewHtml.ts             HTML da webview (CSP + nonce)
  model/
    block.ts                   modelo de blocos comum a todos os formatos
    messages.ts                protocolo de mensagens host <-> webview
  parsers/
    types.ts                   interface FormatAdapter (parse + applyEdit)
    index.ts                   escolhe o adapter pelo languageId ou pela extensão
    textDiff.ts                reduz uma reescrita do texto ao trecho que mudou
    jsonAdapter.ts             jsonc-parser + edições textuais que copiam a formatação existente
    yamlAdapter.ts             yaml (Document API, preserva comentários)
    xmlAdapter.ts              stub
    htmlAdapter.ts             stub
webview/                       React + React Flow
  main.tsx                     ponto de entrada
  App.tsx                      canvas, toolbar, estado (recolhidos) e mensagens
  actions.ts                   contexto com as ações (post, recolher)
  graph/
    buildGraph.ts              Block -> nós e arestas (função pura, testada)
    layout.ts                  layout automático da esquerda para a direita (dagre)
    BlockNode.tsx              card de um objeto/array: linhas editáveis, ações, drag & drop
  styles.css                   tema do VS Code aplicado ao canvas e aos nós
test/                          testes dos adapters e do grafo
samples/                       arquivos para testar
```

**Grafo:** cada objeto ou array vira um card. Valores simples são linhas editáveis dentro do card;
filhos objeto/array saem da linha correspondente por uma aresta até o próprio card. As alturas são
fixas (cabeçalho + N linhas) e as larguras são medidas com canvas, então o layout é calculado antes
de renderizar.

**Fluxo:** o `TextDocument` é a fonte da verdade, então undo/redo, salvar e o estado "modificado"
funcionam nativamente. A cada mudança no documento, o adapter faz o parse do texto em `Block`s e o host
manda o resultado para a webview. Uma edição na webview vira um `BlockEdit`. O adapter converte esse
edit em `TextChange`s, que são aplicadas como `WorkspaceEdit`.

Os adapters não dependem da API do `vscode`, então são testados com testes unitários puros (`test/`).

## Uso

| Ação | Como |
|---|---|
| Navegar | Arraste o fundo para mover, roda do mouse para zoom, minimapa e botões no canto |
| Editar valor | Clique no valor e dê Enter (Esc cancela; checkbox para booleanos) |
| Recolher/expandir | Clique no resumo `{n}` / `[n]` da linha |
| Adicionar | Botão **+** no cabeçalho do card (o VS Code pergunta a chave e o tipo) |
| Renomear | Duplo clique na chave ou botão **✎** |
| Remover | Botão **×** na linha ou no cabeçalho do card |
| Reordenar | Arraste a linha pelo **⠿** ou Alt+↑/↓ com o valor focado |

Tudo passa pelo documento, então **Ctrl+Z** desfaz qualquer ação.

## Roadmap

- [x] Estrutura, Custom Editor, modelo de blocos
- [x] JSON e YAML: visualizar e editar valores escalares
- [x] Adicionar, remover, renomear e reordenar blocos (drag & drop, Alt+↑/↓)
- [x] Visualização em grafo (React Flow + dagre) com pan, zoom e minimapa
- [ ] Busca no grafo (destacar e centralizar nós)
- [ ] Clicar num nó revela o trecho no editor de texto
- [ ] Performance com arquivos grandes (virtualização / recolher níveis profundos por padrão)
- [ ] XML e HTML com parser que guarda posições
- [x] Detecção de indentação no JSON
- [ ] YAML multi-documento
- [ ] Mudar o tipo de um valor (ex.: string → number)
- [ ] Ícones (codicons) no lugar dos glifos de texto
- [ ] Sincronizar a seleção entre o bloco e o texto
- [ ] Edição guiada por schema (JSON Schema / XSD)
- [x] Testes unitários dos adapters
