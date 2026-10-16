# Fileblocks

Extensão do VS Code para visualizar e editar arquivos estruturados (JSON, YAML, TOML, XML, HTML) como um
grafo de nós em um canvas, no estilo do [JSON Crack](https://jsoncrack.com/editor), com edição direta nos nós.

## Desenvolvimento

```bash
npm install
npm run build      # gera dist/extension.js, dist/webview.js e dist/webview.css
npm run watch      # rebuild automático
npm run typecheck  # checagem de tipos (o esbuild não checa tipos)
npm test           # testes unitários dos adapters (node:test)
npm run package    # build de produção + fileblocks-<versão>.vsix
```

Para instalar no VS Code do dia a dia (sem F5): `code --install-extension fileblocks-0.0.1.vsix`,
ou **Extensions → ⋯ → Install from VSIX…**. Para atualizar, gere o `.vsix` de novo e reinstale.

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
    convert.ts                 conversão de valores entre tipos
    messages.ts                protocolo de mensagens host <-> webview
  parsers/
    types.ts                   interface FormatAdapter (parse + applyEdit)
    index.ts                   escolhe o adapter pelo languageId ou pela extensão
    textDiff.ts                reduz uma reescrita do texto ao trecho que mudou
    textEdits.ts               edições textuais compartilhadas (rotacionar irmãos, indentação)
    jsonAdapter.ts             jsonc-parser + edições textuais que copiam a formatação existente
    yamlAdapter.ts             yaml (Document API, preserva comentários; vários documentos)
    tomlAdapter.ts             TOML (toml-eslint-parser; tabelas, chaves com ponto, inline, [[arrays]])
    markupAdapter.ts           XML e HTML (htmlparser2 + leitor de tags com posições dos atributos)
  schema/
    association.ts             qual schema se aplica ($schema, modeline YAML, #:schema, xsi:*, settings)
    navigator.ts               percorre o schema por caminho: dicas, enum, obrigatórios, sugestões, defaults
    validate.ts                validação com ajv e mapeamento dos erros para caminhos de blocos
    xsd.ts                     subconjunto de XSD: validação, dicas e sugestões para XML
    SchemaService.ts           carrega (arquivo/https), compila e faz cache dos schemas; escolha manual
webview/                       React + React Flow
  main.tsx                     ponto de entrada
  App.tsx                      canvas, toolbar, estado (recolhidos) e mensagens
  actions.ts                   contexto com as ações (post, recolher)
  graph/
    buildGraph.ts              Block -> nós e arestas (função pura, testada)
    layout.ts                  layout automático da esquerda para a direita (dagre)
    BlockNode.tsx              card de um objeto/array: linhas editáveis, ações, drag & drop
    search.ts                  busca em chaves e valores (função pura, testada)
    targets.ts                 onde um bloco aparece (card + linha) e o que expandir para mostrá-lo
    collapse.ts                quais níveis recolher ao abrir arquivos grandes
  exportImage.ts               exporta o grafo inteiro como PNG/SVG (html-to-image)
  SearchBox.tsx                campo de busca da toolbar
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
| Buscar | **Ctrl+F** ou o campo na toolbar: procura em chaves e valores; Enter / Shift+Enter (ou ↑/↓) navegam e centralizam o resultado, expandindo nós recolhidos; Esc limpa |
| Ver no texto | Clique na chave de uma linha ou no título de um card: seleciona o trecho no editor de texto ao lado (o foco fica no grafo) |
| Seguir o cursor | Com o texto aberto ao lado, mover o cursor destaca o nó correspondente no grafo (expande recolhidos e centraliza se estiver fora da tela) |
| Editar valor | Clique no valor e dê Enter (Esc cancela; checkbox para booleanos) |
| Recolher/expandir | Clique no resumo `{n}` / `[n]` da linha |
| Adicionar | Botão **+** no cabeçalho do card (o VS Code pergunta a chave e o tipo) |
| Renomear | Duplo clique na chave ou botão **✎** |
| Remover | Botão **×** na linha ou no cabeçalho do card |
| Reordenar | Arraste a linha pelo **⠿** ou Alt+↑/↓ com o valor focado |
| Expandir/recolher tudo | Botões na toolbar |
| Exportar imagem | Botão de exportar na toolbar ou **Fileblocks: Export Graph as Image…** (PNG ou SVG; o grafo inteiro, sem os ícones) |
| Escolher schema | Clique no nome do schema (ou em "No schema") na toolbar, ou **Fileblocks: Select Schema…**: arquivo, URL, detecção automática ou nenhum |
| Mudar o tipo | Botão **⇄** na linha ou no cabeçalho do card (ex.: `"8080"` → `8080`; converter um objeto/array com itens pede confirmação) |

Tudo passa pelo documento, então **Ctrl+Z** desfaz qualquer ação.

**YAML com vários documentos** (`---`): cada documento aparece como uma linha do card `documents`.
Dá para editar dentro de cada documento, e só o texto dele é regravado; os documentos em si não são
removidos ou reordenados pelo grafo.

**XML e HTML:** cada elemento vira um card `<tag>`; os atributos são linhas `@nome` e os textos
linhas `#text`, editáveis. Elementos sem atributos que só têm texto (`<li>JSON</li>`) ou estão vazios
(`<a/>`, `<br>`) não ganham card: são uma linha do card pai com o texto editável; o **+** da linha
adiciona atributo ou filho (e aí o elemento passa a ter card). O **+** pergunta se é elemento filho, atributo ou texto; renomear uma tag
muda a de abertura e a de fechamento. Comentários, `<?xml ?>` e `<!DOCTYPE>` não aparecem mas ficam
no arquivo. Em HTML, tags com fechamento implícito (`<li>` sem `</li>`), atributos sem valor
(`disabled`) e sem aspas (`class=list`) são respeitados.

**TOML:** tabelas `[a]`, chaves com ponto (`a.b = 1`), tabelas e arrays inline e arrays de tabelas
`[[a]]` viram objetos e arrays. Dá para editar valores (datas continuam sem aspas), renomear chaves e
cabeçalhos, remover entradas e seções inteiras, inserir `chave = valor` numa tabela ou itens em `{…}` /
`[…]`, e reordenar entradas da mesma tabela. Objetos que só existem por chaves com ponto não recebem
novas chaves pelo grafo (não há um lugar único no texto para elas).

**JSON Schema** (JSON, YAML e TOML): o schema vem da escolha manual (**Select Schema…**), do `"$schema"`
do próprio arquivo, do comentário `# yaml-language-server: $schema=...` no YAML, da diretiva
`#:schema ...` no TOML, ou das configurações `json.schemas` / `yaml.schemas`.
Schemas remotos são baixados (respeitando `json.schemaDownload.enable`). Com um schema:
valores inválidos e propriedades obrigatórias faltando ficam marcados (a mensagem aparece no tooltip);
a toolbar mostra o schema e o número de problemas (clique para ir ao próximo); chaves obrigatórias
ganham `*` e as descrições aparecem no tooltip; `enum` vira uma lista de opções; e o **+** sugere as
propriedades do schema (obrigatórias primeiro), já com o valor padrão. Veja `samples/app.json`.

**XSD** (XML): o schema vem de `xsi:noNamespaceSchemaLocation` / `xsi:schemaLocation`, da configuração
`xml.fileAssociations` ou do **Select Schema…**. É um subconjunto de XSD avaliado sobre os blocos:
elementos e atributos permitidos e obrigatórios, quantidade máxima, `enumeration`, tipos básicos
(inteiros, decimais, booleano, datas) e facetas (min/max, tamanho, `pattern`); `include`/`import` são
carregados. Não verifica a ordem dentro de `sequence`, namespaces nem restrições de identidade.
Documentação do XSD aparece nos tooltips e o **+** sugere atributos e filhos válidos. Veja `samples/catalog.xml`.

**Arquivos grandes:** na primeira abertura, se o grafo passar de 150 cards, só os primeiros níveis
ficam expandidos (a toolbar avisa); a busca e o cursor do texto expandem o que for preciso. Acima de
100 cards, o canvas só renderiza os cards visíveis, e cards com mais de 100 linhas só renderizam as
linhas visíveis. Exportar como PNG um grafo muito grande pode demorar e sai com resolução reduzida
(máx. 8000 px por lado); para esses casos, prefira SVG.

## Roadmap

- [x] Estrutura, Custom Editor, modelo de blocos
- [x] JSON e YAML: visualizar e editar valores escalares
- [x] Adicionar, remover, renomear e reordenar blocos (drag & drop, Alt+↑/↓)
- [x] Visualização em grafo (React Flow + dagre) com pan, zoom e minimapa
- [x] Busca no grafo (destacar, navegar e centralizar resultados)
- [x] Clicar num nó revela o trecho no editor de texto
- [x] Performance com arquivos grandes (virtualização / recolher níveis profundos por padrão)
- [x] Virtualizar as linhas dentro de cards enormes (ex.: um array com milhares de itens)
- [x] XML e HTML com parser que guarda posições
- [x] XML/HTML: mostrar elementos só com texto (`<li>JSON</li>`) como uma linha, sem card próprio
- [x] Detecção de indentação no JSON
- [x] YAML multi-documento
- [x] Mudar o tipo de um valor (ex.: string → number)
- [x] Ícones (codicons) no lugar dos glifos de texto
- [x] Sincronizar a seleção entre o bloco e o texto
- [x] Edição guiada por JSON Schema (validação, dicas, enum, sugestões)
- [x] XSD para XML (subconjunto)
- [x] Expandir/recolher tudo, exportar PNG/SVG, escolher schema manualmente
- [x] TOML
- [ ] DTD para XML
- [x] Testes unitários dos adapters
- [x] Empacotar como .vsix
