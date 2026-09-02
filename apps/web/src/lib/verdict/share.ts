/**
 * The sharing row under the verdict card.
 *
 * `brief` Part 6 wants the verdict page to travel: it is the paid deliverable and
 * the thing a founder puts in front of other people. Four ways out of the page,
 * and each of them carries the same sentence:
 *
 * - **Copy verdict line** — the one-liner plus the permanent URL, on the clipboard.
 * - **Post on X** — the same one-liner as an intent, with the URL as the card.
 * - **Badge for README** — the markdown for `badge.svg`, with the badge shown beside
 *   it so nobody has to paste it somewhere to find out what it looks like.
 * - **Download** — the offline copy the page already serves at `?download=1`.
 *
 * ## Never promise a rank, on any of them
 *
 * `brief` Part 5: "**Never promise a rank in copy.** The verdict card is stamped
 * with a timestamp and product count precisely because the board moves." Every
 * string this module produces is built from `stampedRank`, which cannot emit a
 * rank without both stamps beside it, so there is no path through here that puts
 * a bare rank on somebody else's timeline. The one exception is the badge's alt
 * text, which is a shields-style label with no room for a timestamp and carries
 * the product count instead — and the badge it labels links back to the stamped
 * page, which is where the claim is actually made.
 *
 * ## Escaping, and the two sinks
 *
 * This module writes into two sinks with different rules and does not confuse
 * them. HTML text and attributes go through `escapeHtml` — `@the-pit/auth`'s, the
 * same one `page.ts` uses, imported from the package rather than from `page.ts`
 * so that a page which renders this row does not import a module that imports it
 * back. A URL's query goes through `encodeURIComponent`, which is a different
 * question with a different answer; escaping a query parameter for HTML would put
 * `&amp;` in somebody's tweet.
 *
 * The copy buttons carry their payload in a `data-` attribute rather than inside
 * the inline script, so no verdict text is ever interpolated into JavaScript.
 * There is no product name that can close the `<script>` element, because no
 * product name is in it.
 */

import { escapeHtml } from '@the-pit/auth';

import { badgeWidth } from './badge';
import type { Verdict } from './model';
import { trimTo } from './og';
import { cutsLine, stampedRank } from './page';

/**
 * X counts a link as a fixed 23 characters whatever its length, so the text has
 * to leave room for one. 200 keeps the whole post inside 280 with the URL, the
 * space before it and a little slack for a long designation.
 */
const TWEET_LIMIT = 200;

/**
 * An HTML attribute value.
 *
 * `escapeHtml` handles the five characters that matter to a parser; the newline
 * is added here because the copy payload is a two-line string and a raw newline
 * inside an attribute survives serialisation but not every intermediary that
 * rewrites HTML. `&#10;` is the same character with none of that risk.
 */
function attr(value: string): string {
  return escapeHtml(value).replaceAll('\n', '&#10;');
}

/** The permanent public URL for one verdict. */
export function verdictUrl(verdict: Verdict, origin: string): string {
  return `${origin}/v/${encodeURIComponent(verdict.slug)}`;
}

/**
 * The one-line summary, as it travels.
 *
 * `cutsLine`'s full stop is dropped before the interpunct: "took 17 in cuts. · 1
 * of 48" reads as a typo, and the clause after the dot is a stamp rather than a
 * new sentence.
 */
export function shareLine(verdict: Verdict): string {
  return `${cutsLine(verdict).replace(/\.\s*$/, '')} · ${stampedRank(verdict)}`;
}

/** What the copy button puts on the clipboard: the line, then the URL. */
export function shareClipboardText(verdict: Verdict, origin: string): string {
  return `${shareLine(verdict)}\n${verdictUrl(verdict, origin)}`;
}

/**
 * The X intent.
 *
 * `text` and `url` are separate parameters because X renders the URL as a card
 * rather than as text, and a URL pasted into `text` is counted twice. The text is
 * trimmed to `TWEET_LIMIT` on a word boundary by `og.ts`'s `trimTo` — the same
 * trimmer the share card uses, so a long designation is shortened the same way on
 * both surfaces.
 */
export function tweetIntentUrl(verdict: Verdict, origin: string): string {
  const text = trimTo(shareLine(verdict), TWEET_LIMIT);
  return (
    'https://twitter.com/intent/tweet' +
    `?text=${encodeURIComponent(text)}` +
    `&url=${encodeURIComponent(verdictUrl(verdict, origin))}`
  );
}

/**
 * The badge's label — the alt text and the SVG's own title.
 *
 * `#7 of 48 in Developer Tools`. The count travels with the rank here too; the
 * timestamp does not fit a 20px shield and lives on the page the badge links to.
 */
export function badgeAlt(verdict: Verdict): string {
  return `The Pit: #${verdict.rank} of ${verdict.productCount} in ${verdict.category}`;
}

/**
 * The README snippet: the badge, linked to the verdict.
 *
 * Markdown, not HTML, so the escaping question is a different one — `[` and `]`
 * inside the alt text would close the label early. A category label from the
 * catalog contains neither, but the payload is the sink's input and not its
 * guarantee, so they are neutralised rather than trusted.
 */
export function badgeMarkdown(verdict: Verdict, origin: string): string {
  const url = verdictUrl(verdict, origin);
  const alt = badgeAlt(verdict).replaceAll('[', '(').replaceAll(']', ')');
  return `[![${alt}](${url}/badge.svg)](${url})`;
}

/**
 * One delegated listener for both copy buttons.
 *
 * No verdict text is in here: each button carries its own payload in
 * `data-copy`, so this string is a constant and cannot be broken by a product
 * name. `navigator.clipboard` is unavailable on an insecure origin and in a few
 * older browsers, so the textarea/`execCommand` path is kept — this page is meant
 * to be saved to disk and opened from `file://`, where the async API is refused.
 */
const COPY_SCRIPT = `
(function(){
  function fallback(text){
    var area=document.createElement('textarea');
    area.value=text;area.setAttribute('readonly','');
    area.style.position='fixed';area.style.top='-1000px';area.style.opacity='0';
    document.body.appendChild(area);area.select();
    var ok=false;try{ok=document.execCommand('copy');}catch(e){ok=false;}
    document.body.removeChild(area);return ok;
  }
  function flash(button){
    if(button.dataset.busy==='1')return;
    button.dataset.busy='1';
    var was=button.dataset.label||button.textContent;
    button.dataset.label=was;
    button.textContent='Copied';
    window.setTimeout(function(){button.textContent=was;button.dataset.busy='';},1500);
  }
  document.addEventListener('click',function(event){
    var button=event.target instanceof Element?event.target.closest('[data-copy]'):null;
    if(button===null)return;
    event.preventDefault();
    var text=button.getAttribute('data-copy')||'';
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){flash(button);},function(){if(fallback(text))flash(button);});
    }else if(fallback(text)){flash(button);}
  });
})();`.trim();

/**
 * The four controls, as one row.
 *
 * The badge preview is an `<img>` of the live `badge.svg` rather than an inlined
 * copy of it: the badge a reader sees here is then the same bytes their README
 * will fetch, and there is no second renderer to drift from the first.
 */
export function renderShareRow(verdict: Verdict, options: { readonly origin: string }): string {
  const { origin } = options;
  const badge = `${verdictUrl(verdict, origin)}/badge.svg`;
  const alt = badgeAlt(verdict);

  return [
    '<div class="share-row">',
    `<button type="button" class="sact" data-copy="${attr(shareClipboardText(verdict, origin))}">`,
    'Copy verdict line</button>',
    `<a class="sact" href="${attr(tweetIntentUrl(verdict, origin))}" `,
    'target="_blank" rel="noopener noreferrer">Post on X</a>',
    `<button type="button" class="sact" data-copy="${attr(badgeMarkdown(verdict, origin))}">`,
    'Badge for README</button>',
    `<img class="sbadge" src="${attr(badge)}" alt="${attr(alt)}" `,
    `width="${badgeWidth(verdict)}" height="20" loading="lazy">`,
    `<a class="sact" href="?download=1" download="the-pit-${attr(verdict.slug)}.html">Download</a>`,
    `<script>${COPY_SCRIPT}</script>`,
    '</div>',
  ].join('');
}
