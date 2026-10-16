# The Verse website

Public site for the Verse megagame: the GNN bulletin, the rules and the faction pages.
Built with [Hugo](https://gohugo.io) and published to GitHub Pages by `.github/workflows/deploy.yml`
every time something is pushed to `main`.

## Where things live

| What | File |
|---|---|
| Home page text | `content/_index.md` |
| Rules (the Game Guide) | `content/rules/_index.md` |
| Faction pages | `content/factions/<code>.md`, e.g. `utf.md` |
| GNN bulletins | `content/gnn/turn-NN.md`, e.g. `turn-11.md` |
| Diplomacy: Treaties & Trade | `content/diplomacy/treaties.md` |
| Diplomacy: Diplomatic Relations | `content/diplomacy/relations.md` |
| Diplomatic relation grid | `data/relations.yaml` |
| Library (background reading) | `content/library/*.md` |
| Images | `static/images/` |
| QR code for player packs | `static/images/qr/the-verse-qr.png` (and `.svg` for print) |

## Adding a GNN bulletin

Create `content/gnn/turn-12.md` (two digits: `turn-09.md`, `turn-12.md`) starting with:

```
---
title: "GNN Bulletin 2602, Turn 12"
turn: 12
staryear: 2602
date: 2026-10-20
---
```

`date` is the real-world posting date, written year-month-day. Under the header, paste the
bulletin. Start each story with a headline line beginning `## `, for example
`## PFR FLEET SIGHTED OVER FELGOR`. Headlines become the bulletin's contents list, and any
headline naming a faction is listed on that faction's page automatically.

To add a story image, put it in `static/images/gnn/turn-12/` and add a line above the
story's headline, e.g. `![Proxima fleet over Felgor](/images/gnn/turn-12/01.jpg)`. Keep images
around 1200 pixels wide (JPEG) so pages stay quick on phones. The GNN masthead is added to every
bulletin automatically.

Commit and push. The site updates in about a minute; progress shows under the repository's
**Actions** tab.

## Faction pages

Player factions, other sovereign states and corporations all live in `content/factions/`.
`group: "state"` puts a page among the factions after the player factions, and
`group: "corporate"` puts it under **Major Corporate Entities**. `kind` is the line shown under
the name on its card, and `weight` sets the order.

`gnn_keywords` in a faction page's header lists the words that link GNN headlines to it.
The sovereign state and corporate pages use `gnn_mentions` instead, which searches the whole
text of every story, not just the headline.
`flag`, `portrait` and `caption` set its images.

## Diplomacy grid

The grid on the Diplomatic Relations page is drawn from `data/relations.yaml`. Each row lists that
faction's relationships: `T` trade agreement, `S` strategic trade, `W` war, `CF` ceasefire, `NA` non-aggression pact,
`AA` alliance, combined with a space (`T NA`). Leave a faction out for no relationship.

## Library pages

Add `toc: true` to a page's header for a contents bar. Add
`gnn_mentions: ["Unity 5"]` to list every GNN story whose headline or text mentions those
words (the Unity 5 and Skaro Pact pages work this way). Images with a caption are written
`![short description](/images/library/name.jpg "Caption text")`.

## Previewing on your Mac

```
hugo server
```

Then open http://localhost:1313/the-verse/ . Stop it with Ctrl+C.

## Search engines

The rules page carries `noindex: true`, which asks search engines not to list it, and is left
out of the sitemap. Anyone with the link can still read it.

## Custom domain later

In the repository's **Settings → Pages → Custom domain**, enter the domain and follow GitHub's
DNS instructions. The workflow picks up the new address automatically; nothing in the site
needs editing. Regenerate the QR code afterwards, because it points at the github.io address.
