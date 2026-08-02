// Converts PocketTube's LIVE `get_channel_data` reply into the flat PocketTube
// storage-dump format that POST /api/categories/import/ already consumes — the
// same shape the cloud backup yields, so both sources take the identical
// preview / filter / commit path afterwards.
//
// Loaded by background.js via importScripts().
//
// Verified reply shape (live, in Chrome):
//   groupTree   : array of root nodes; node =
//                 { titleGroup, channelsList: [...], child: [ ...nodes ], ... }
//   channelsList: [ { channelId, title, img, subscriberCount, ... } ]
//   channelList : { "<UC…>": { img, title, count } }   — CHANNEL metadata
//   metaList    : { "<category name>": { img, position } } — GROUP metadata,
//                 NOT channel metadata, so it is never read as such here; its
//                 `position` is re-emitted as ysc_meta[name].position, the same
//                 field the cloud dump ships verbatim
//   settings.sub_groups : { parent: { child: {} } }
//   finish      : false even in a complete reply — never a completion signal

(function (root) {
  'use strict';

  var CHANNEL_ID_RE = /^UC[\w-]{22}$/;
  var IMG_URL_RE = /^(https?:)?\/\//i;

  // Field limits from subscriptions/models.py — anything longer is truncated
  // here so the backend never gets a value it cannot store.
  var MAX_CATEGORY_NAME = 256;    // Category.name
  var MAX_CHANNEL_TITLE = 256;    // Subscription.channel_title
  var MAX_THUMBNAIL_URL = 512;    // Subscription.thumbnail_url
  var MAX_SUBSCRIBER_COUNT = 32;  // Subscription.subscriber_count
  var MAX_TOPIC = 128;
  var MAX_TOPICS = 50;

  // A hostile or corrupt reply must not be able to make the walk run forever.
  var MAX_TREE_DEPTH = 32;
  var MAX_TREE_NODES = 20000;

  // Mirrors POCKETTUBE_INTERNAL_KEYS in subscriptions/views.py: a category with
  // one of these names would be read as a settings blob or a PocketTube cache,
  // not as a category. This payload synthesises ysc_meta, so the registry rule
  // decides downstream — but a reserved name registered there would be counted,
  // so such names are dropped before they can reach it.
  var INTERNAL_KEYS = {
    channelsHealth: true, topicCache: true,
    ysc_channel_metadata: true, ysc_collection: true, ysc_deck: true,
    ysc_meta: true, ysc_popup: true, ysc_settings: true,
    ysc_subs_count: true, ysc_title_id: true, ysc_token_google: true,
    liveStreamsCurrent: true, nvl: true, nvlo: true, lastWatchedId: true,
    api_counter: true, backupExpired: true, channelsHealthExpired: true,
    topicCounter: true, topicExpired: true, watchedCounter: true,
    watchedExpired: true
  };

  // Mirrors SEND_DENY_KEYS in background.js. Those keys are withheld from the
  // app, so registering them in ysc_meta would only smuggle the name back in
  // while registering a category that can never arrive.
  var SEND_DENY_NAMES = { patreon: true, yu: true, ysc_token_google: true };

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function truncate(value, max) {
    var str = String(value == null ? '' : value);
    return str.length > max ? str.slice(0, max) : str;
  }

  function looksLikeChannelId(value) {
    return typeof value === 'string' && CHANNEL_ID_RE.test(value);
  }

  function isInteger(value) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
  }

  // `metaList` is keyed by CATEGORY name (never channel id) and is the same
  // ordering PocketTube's cloud dump ships as ysc_meta[name].position.
  function readMetaPositions(metaList) {
    var positions = {};
    if (!isPlainObject(metaList)) return positions;
    Object.keys(metaList).forEach(function (rawName) {
      var entry = metaList[rawName];
      if (!isPlainObject(entry) || !isInteger(entry.position)) return;
      var name = truncate(String(rawName).trim(), MAX_CATEGORY_NAME);
      if (!name || positions[name] !== undefined) return;
      positions[name] = entry.position;
    });
    return positions;
  }

  function normaliseMetaEntry(value, channelId) {
    if (typeof value === 'string') {
      return { title: truncate(value, MAX_CHANNEL_TITLE), img: '' };
    }
    if (!isPlainObject(value)) return null;
    var title = typeof value.title === 'string' ? value.title : '';
    var img = typeof value.img === 'string' ? value.img : '';
    if (img && !IMG_URL_RE.test(img)) img = '';
    if (img.indexOf('//') === 0) img = 'https:' + img;
    if (!title && !img) return null;
    return {
      title: truncate(title || channelId, MAX_CHANNEL_TITLE),
      img: truncate(img, MAX_THUMBNAIL_URL)
    };
  }

  // Same rules as the cloud path used: only channel-keyed entries, only a
  // string/finite-number `sc`, topics coerced to a capped list of strings.
  function sanitiseSubsCount(value) {
    if (!isPlainObject(value)) return null;
    var out = {};
    var kept = 0;
    Object.keys(value).forEach(function (key) {
      if (!looksLikeChannelId(key)) return;
      var entry = value[key];
      if (!isPlainObject(entry)) return;
      var sc = null;
      if (typeof entry.sc === 'string') sc = entry.sc;
      else if (typeof entry.sc === 'number' && isFinite(entry.sc)) sc = String(entry.sc);
      var topics = Array.isArray(entry.t)
        ? entry.t.filter(function (t) { return typeof t === 'string' && t; })
          .slice(0, MAX_TOPICS)
          .map(function (t) { return truncate(t, MAX_TOPIC); })
        : [];
      if (sc === null && !topics.length) return;
      var clean = { t: topics };
      if (sc !== null) clean.sc = truncate(sc, MAX_SUBSCRIBER_COUNT);
      out[key] = clean;
      kept += 1;
    });
    return kept ? out : null;
  }

  // The backend iterates `sub_groups[parent]` expecting `{child: {}}`; a string
  // value would silently be iterated character by character.
  function validateSubGroups(value) {
    if (!isPlainObject(value)) return { ok: false, reason: 'it is not an object' };
    var out = {};
    var kept = 0;
    var parents = Object.keys(value);
    for (var i = 0; i < parents.length; i += 1) {
      var children = value[parents[i]];
      if (!isPlainObject(children)) {
        return {
          ok: false,
          reason: '"' + parents[i] + '" maps to a ' + (Array.isArray(children)
            ? 'array' : typeof children) + ', not an object'
        };
      }
      var node = {};
      var childNames = Object.keys(children);
      for (var j = 0; j < childNames.length; j += 1) {
        var child = children[childNames[j]];
        if (child != null && !isPlainObject(child)) {
          return { ok: false, reason: 'child "' + childNames[j] + '" is not an object' };
        }
        node[truncate(childNames[j], MAX_CATEGORY_NAME)] = {};
      }
      out[truncate(parents[i], MAX_CATEGORY_NAME)] = node;
      kept += 1;
    }
    return kept ? { ok: true, value: out } : { ok: false, reason: 'it is empty' };
  }

  function deriveSubGroups(edges) {
    var subGroups = {};
    edges.forEach(function (edge) {
      if (!subGroups[edge[0]]) subGroups[edge[0]] = {};
      subGroups[edge[0]][edge[1]] = {};
    });
    return subGroups;
  }

  function collectChannels(list, name, ctx) {
    if (!Array.isArray(list)) return;
    var bucket = ctx.map[name];
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i];
      if (!isPlainObject(entry)) continue;
      var id = entry.channelId;
      if (!looksLikeChannelId(id)) {
        ctx.rejectedChannelIds += 1;
        continue;
      }
      bucket[id] = true;
      ctx.referenced[id] = true;
      if (!ctx.meta[id]) {
        var meta = normaliseMetaEntry(entry, id);
        if (meta) ctx.meta[id] = meta;
      }
      if (!ctx.subs[id] && entry.subscriberCount !== undefined) {
        ctx.subs[id] = { sc: entry.subscriberCount, t: [] };
      }
    }
  }

  // `groupTree` is an ARRAY of root nodes; nesting is the `child` array.
  function walkGroupTree(nodes, parentName, ctx, depth) {
    if (!Array.isArray(nodes) || depth > MAX_TREE_DEPTH) return;
    for (var i = 0; i < nodes.length; i += 1) {
      if (ctx.nodes >= MAX_TREE_NODES) return;
      var node = nodes[i];
      if (!isPlainObject(node)) continue;
      ctx.nodes += 1;

      var rawName = typeof node.titleGroup === 'string' ? node.titleGroup.trim() : '';
      var name = rawName ? truncate(rawName, MAX_CATEGORY_NAME) : '';
      if (name) {
        if (name !== rawName) ctx.truncatedNames += 1;
        if (!ctx.map[name]) ctx.map[name] = {};
        if (ctx.treePositions[name] === undefined && isInteger(node.positionGroup)) {
          ctx.treePositions[name] = node.positionGroup;
        }
        collectChannels(node.channelsList, name, ctx);
        if (parentName && parentName !== name) ctx.edges.push([parentName, name]);
      }
      walkGroupTree(node.child, name || parentName, ctx, depth + 1);
    }
  }

  function buildLivePayload(raw) {
    if (!isPlainObject(raw)) {
      throw new Error('PocketTube\u2019s live reply was not an object.');
    }
    var groupTree = Array.isArray(raw.groupTree) ? raw.groupTree : null;
    var channelList = isPlainObject(raw.channelList) ? raw.channelList : {};
    if (!groupTree) {
      throw new Error('PocketTube\u2019s live reply has no groupTree array.');
    }

    var warnings = [];
    var ctx = {
      map: {}, edges: [], meta: {}, subs: {}, referenced: {}, treePositions: {},
      nodes: 0, truncatedNames: 0, rejectedChannelIds: 0
    };
    walkGroupTree(groupTree, null, ctx, 0);

    if (ctx.nodes >= MAX_TREE_NODES) {
      warnings.push('Group tree cut off at ' + MAX_TREE_NODES +
        ' nodes; this preview is incomplete.');
    }
    if (ctx.truncatedNames) {
      warnings.push(ctx.truncatedNames + ' category name(s) shortened to ' +
        MAX_CATEGORY_NAME + ' characters.');
    }
    if (ctx.rejectedChannelIds) {
      warnings.push(ctx.rejectedChannelIds + ' group-tree entr' +
        (ctx.rejectedChannelIds === 1 ? 'y' : 'ies') + ' had no valid channel id.');
    }

    // Anything the group tree did not describe falls back to the reply's
    // channel-keyed metadata map.
    Object.keys(ctx.referenced).forEach(function (id) {
      if (ctx.meta[id]) return;
      var meta = normaliseMetaEntry(channelList[id], id);
      if (meta) ctx.meta[id] = meta;
    });

    var settings = isPlainObject(raw.settings) ? raw.settings : null;
    var subGroups = null;
    if (settings && settings.sub_groups != null) {
      var validated = validateSubGroups(settings.sub_groups);
      if (validated.ok) {
        subGroups = validated.value;
      } else {
        warnings.push('Ignored settings.sub_groups (' + validated.reason +
          '); hierarchy taken from the group tree.');
      }
    }
    if (!subGroups && ctx.edges.length) {
      subGroups = deriveSubGroups(ctx.edges);
    }

    // A category that only carries the hierarchy still has to ship, as an empty
    // list, or the backend cannot wire its parent up.
    var inHierarchy = {};
    ctx.edges.forEach(function (edge) {
      inHierarchy[edge[0]] = true;
      inHierarchy[edge[1]] = true;
    });
    if (subGroups) {
      Object.keys(subGroups).forEach(function (parent) {
        inHierarchy[parent] = true;
        Object.keys(subGroups[parent]).forEach(function (child) {
          inHierarchy[child] = true;
        });
      });
    }

    var payload = {};
    var categoryNames = [];
    var assignments = 0;
    Object.keys(ctx.map).forEach(function (name) {
      if (INTERNAL_KEYS[name]) {
        warnings.push('Skipped category "' + name + '" \u2014 reserved PocketTube key.');
        return;
      }
      var ids = Object.keys(ctx.map[name]);
      if (!ids.length && !inHierarchy[name]) return;
      payload[name] = ids;
      categoryNames.push(name);
      assignments += ids.length;
    });

    // A parent named only by sub_groups must appear as a key too, otherwise the
    // backend skips it and its children stay top level.
    if (subGroups) {
      Object.keys(subGroups).forEach(function (parent) {
        if (payload[parent] || INTERNAL_KEYS[parent]) return;
        var hasKnownChild = Object.keys(subGroups[parent]).some(function (child) {
          return !!payload[child];
        });
        if (hasKnownChild) {
          payload[parent] = [];
          categoryNames.push(parent);
        }
      });
    }

    var missingMeta = 0;
    Object.keys(ctx.referenced).forEach(function (id) {
      if (ctx.meta[id]) return;
      ctx.meta[id] = { title: id, img: '' };
      missingMeta += 1;
    });
    if (missingMeta) {
      warnings.push(missingMeta + ' channel(s) had no title or image; ' +
        'imported under their channel id.');
    }

    payload.ysc_channel_metadata = ctx.meta;
    if (subGroups) payload.ysc_settings = { sub_groups: subGroups };
    var subsCount = sanitiseSubsCount(ctx.subs);
    if (subsCount) payload.ysc_subs_count = subsCount;

    // ysc_meta carries PocketTube's display ordering, and its keys are half of
    // the category registry the backend and the preview use to decide what IS a
    // category. So every emitted category needs an entry even when no position
    // is known: a partial map would silently drop the categories missing from
    // it. Position falls back to the node's positionGroup, then to nothing.
    var meta = {};
    var metaPositions = readMetaPositions(raw.metaList);
    categoryNames.forEach(function (name) {
      if (SEND_DENY_NAMES[name]) return;
      var position = metaPositions[name] !== undefined
        ? metaPositions[name]
        : ctx.treePositions[name];
      meta[name] = position === undefined ? {} : { position: position };
    });
    payload.ysc_meta = meta;

    return {
      payload: payload,
      warnings: warnings,
      stats: {
        categories: categoryNames.length,
        channels: Object.keys(ctx.referenced).length,
        assignments: assignments,
        metadataEntries: Object.keys(ctx.meta).length,
        treeNodes: ctx.nodes
      }
    };
  }

  root.buildLivePayload = buildLivePayload;
  // Exported for the test harness only.
  root.validateSubGroups = validateSubGroups;
}(typeof self !== 'undefined' ? self : this));
