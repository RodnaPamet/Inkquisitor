/**
 * Scene HTML and the plain text the prose checks read from it (Phase 5.2, D34).
 * The unit suite holds the SERVER's reader (`HtmlTextReader`) to each `plain`;
 * the rendered suite holds the EDITOR's rebuild (`buildEditorTextMap` over the
 * TipTap document loaded from the same HTML) to the same `plain` — so the two
 * agree, and a finding's offsets mean the same place on both sides.
 */
export const PROSE_TEXT_SAMPLES: ReadonlyArray<{ name: string; html: string; plain: string }> = [
    { name: 'two paragraphs', html: '<p>The ferry crossed.</p><p>Gulls wheeled.</p>', plain: 'The ferry crossed.\nGulls wheeled.' },
    { name: 'marks inside a paragraph', html: '<p>He <em>never</em> went, <strong>not once</strong>.</p>', plain: 'He never went, not once.' },
    { name: 'a mention', html: '<p>She met <span data-mention="e1">@Gull</span> at dusk.</p>', plain: 'She met @Gull at dusk.' },
    { name: 'a list and a quote with a hard break', html: '<ul><li><p>One</p></li><li><p>Two</p></li></ul><blockquote><p>Three<br>four</p></blockquote>', plain: 'One\nTwo\nThree\nfour' },
    { name: 'a scene break and an empty paragraph', html: '<p>Before.</p><hr><p></p><p>After.</p>', plain: 'Before.\nAfter.' },
    { name: 'entities', html: '<p>Salt &amp; iron &lt;here&gt;.</p>', plain: 'Salt & iron <here>.' },
    { name: 'curly speech', html: '<p>“Come in,” she said.</p>', plain: '“Come in,” she said.' },
];
