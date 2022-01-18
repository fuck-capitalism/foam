import markdownItRegex from 'markdown-it-regex';
import * as vscode from 'vscode';
import { FoamFeature } from '../types';
import { isNone, isSome } from '../utils';
import { Foam } from '../core/model/foam';
import { FoamWorkspace } from '../core/model/workspace';
import { Logger } from '../core/utils/log';
import { toVsCodeUri } from '../utils/vsc-utils';
import { Resource } from '../core/model/note';
import axios from 'axios';
import { fromVsCodeUri } from '../utils/vsc-utils';
import TurndownService from 'turndown';
const turndownService = new TurndownService();

const ALIAS_DIVIDER_CHAR = '|';
const refsStack: string[] = [];

export const agoraData = {};

export const getAgoraData = async (wikilink: string) => {
  const { data } = await axios.get(
    `http://localhost:5000/pull/${wikilink}.json`
  );
  console.log(JSON.stringify(data));
  console.log('DATA', data);
  agoraData[wikilink] = data['pushed_nodes'];
};

const feature: FoamFeature = {
  activate: async (
    _context: vscode.ExtensionContext,
    foamPromise: Promise<Foam>
  ) => {
    const foam = await foamPromise;
    vscode.window.onDidChangeActiveTextEditor(editor => {
      const note = foam.services.parser.parse(
        fromVsCodeUri(editor.document.uri),
        editor.document.getText()
      );
      getAgoraData(note.title).then(() => console.log('AGORA DATA', agoraData));
    });
    return {
      extendMarkdownIt: (md: markdownit) => {
        return [
          markdownItWithFoamTags,
          markdownItWithNoteInclusion,
          markdownItWithAgoraInclusion,
          markdownItWithFoamLinks,
          markdownItWithRemoveLinkReferences,
        ].reduce((acc, extension) => extension(acc, foam.workspace), md);
      },
    };
  },
};

export const markdownItWithNoteInclusion = (
  md: markdownit,
  workspace: FoamWorkspace
) => {
  return md.use(markdownItRegex, {
    name: 'include-notes',
    regex: /!\[\[([^[\]]+?)\]\]/,
    replace: (wikilink: string) => {
      try {
        const includedNote = workspace.find(wikilink);

        if (!includedNote) {
          return `![[${wikilink}]]`;
        }

        const cyclicLinkDetected = refsStack.includes(
          includedNote.uri.path.toLocaleLowerCase()
        );

        if (!cyclicLinkDetected) {
          refsStack.push(includedNote.uri.path.toLocaleLowerCase());
        }

        if (cyclicLinkDetected) {
          return `<div class="foam-cyclic-link-warning">Cyclic link detected for wikilink: ${wikilink}</div>`;
        } else {
          let content = includedNote.source.text;
          const section = Resource.findSection(
            includedNote,
            includedNote.uri.fragment
          );
          if (isSome(section)) {
            const rows = content.split('\n');
            content = rows
              .slice(section.range.start.line, section.range.end.line)
              .join('\n');
          }
          const html = md.render(content);
          refsStack.pop();
          return html;
        }
      } catch (e) {
        Logger.error(
          `Error while including [[${wikilink}]] into the current document of the Preview panel`,
          e
        );
        return '';
      }
    },
  });
};

export const markdownItWithFoamLinks = (
  md: markdownit,
  workspace: FoamWorkspace
) => {
  return md.use(markdownItRegex, {
    name: 'connect-wikilinks',
    regex: /\[\[([^[\]]+?)\]\]/,
    replace: (wikilink: string) => {
      try {
        const linkHasAlias = wikilink.includes(ALIAS_DIVIDER_CHAR);
        const resourceLink = linkHasAlias
          ? wikilink.substring(0, wikilink.indexOf('|'))
          : wikilink;

        const resource = workspace.find(resourceLink);
        if (isNone(resource)) {
          return getPlaceholderLink(resourceLink);
        }

        const linkLabel = linkHasAlias
          ? wikilink.substr(wikilink.indexOf('|') + 1)
          : wikilink;

        const link = vscode.workspace.asRelativePath(toVsCodeUri(resource.uri));
        return `<a class='foam-note-link' title='${resource.title}' href='/${link}' data-href='/${link}'>${linkLabel}</a>`;
      } catch (e) {
        Logger.error(
          `Error while creating link for [[${wikilink}]] in Preview panel`,
          e
        );
        return getPlaceholderLink(wikilink);
      }
    },
  });
};

const getPlaceholderLink = (content: string) =>
  `<a class='foam-placeholder-link' title="Link to non-existing resource" href="javascript:void(0);">${content}</a>`;

export const markdownItWithFoamTags = (
  md: markdownit,
  workspace: FoamWorkspace
) => {
  return md.use(markdownItRegex, {
    name: 'foam-tags',
    regex: /(?<=^|\s)(#[0-9]*[\p{L}/_-][\p{L}\p{N}/_-]*)/u,
    replace: (tag: string) => {
      try {
        const resource = workspace.find(tag);
        if (isNone(resource)) {
          return getFoamTag(tag);
        }
      } catch (e) {
        Logger.error(
          `Error while creating link for ${tag} in Preview panel`,
          e
        );
        return getFoamTag(tag);
      }
    },
  });
};

export const markdownItWithAgoraInclusion = (md: markdownit) => {
  return md.use(markdownItRegex, {
    name: 'agora-inclusion',
    regex: /\[\[agora pull\]\] \[\[([^[\]]+?)\]\]/,
    replace: (wikilink: string) => {
      const data = agoraData[wikilink];
      console.log('DATA', data);
      const links = [];
      for (const node of data) {
        let markdown = md.render(node.content.replace(/<[^>]+>/g, ''));
        // const markdown = turndownService.turndown(node.content);
        links.push(`<div>
        <div>Uri: <a href='http://localhost:5000/@${node.user}/${node.source_wikilink}'>${node.user}/${node.source_wikilink}</a></div>
        <div>Content: ${markdown}</div>
        </div>`);
      }
      return links.join('\n');
    },
  });
};

const getFoamTag = (content: string) =>
  `<span class='foam-tag'>${content}</span>`;

export const markdownItWithRemoveLinkReferences = (
  md: markdownit,
  workspace: FoamWorkspace
) => {
  md.inline.ruler.before('link', 'clear-references', state => {
    if (state.env.references) {
      Object.keys(state.env.references).forEach(refKey => {
        // Forget about reference links that contain an alias divider
        // Aliased reference links will lead the MarkdownParser to include wrong link references
        if (refKey.includes(ALIAS_DIVIDER_CHAR)) {
          delete state.env.references[refKey];
        }

        // When the reference is present due to an inclusion of that note, we
        // need to remove that reference. This ensures the MarkdownIt parser
        // will not replace the wikilink syntax with an <a href> link and as a result
        // break our inclusion logic.
        if (state.src.toLowerCase().includes(`![[${refKey.toLowerCase()}]]`)) {
          delete state.env.references[refKey];
        }
      });
    }
    return false;
  });
  return md;
};

export default feature;
