import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
} from "../../../auto-reply/reply-payload.js";
import { hasReplyPayloadContent } from "../../../interactive/payload.js";
import { splitMediaFromOutput } from "../../../media/parse.js";
import {
  copyCoreTtsAttemptResultProvenance,
  getCoreTtsAttemptResultMediaUrls,
} from "../../tools/tts-tool-result-provenance.js";
import type { EmbeddedAgentRunResult } from "../types.js";

/** Channel payload shape produced by embedded runs after auto-reply normalization. */
type EmbeddedRunPayload = NonNullable<EmbeddedAgentRunResult["payloads"]>[number];

type ToolMediaBatch = {
  toolMediaUrls?: readonly string[];
  toolMediaSelectionUrls?: readonly string[];
  hostOwnedToolMediaUrls?: readonly string[];
  toolAutoDeliveryMediaUrls?: readonly string[];
  toolAudioAsVoice?: boolean;
  toolTrustedLocalMedia?: boolean;
};

type ToolMediaMergeParams = ToolMediaBatch & {
  payloads?: EmbeddedRunPayload[];
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
};

function selectToolMedia(params: ToolMediaMergeParams) {
  let mediaUrls = normalizeUniqueTrimmedStringList(params.toolMediaUrls);
  const eligibleUrls = new Set(mediaUrls);
  const explicitSelection = params.toolMediaSelectionUrls !== undefined;
  const referenceUrls = normalizeUniqueTrimmedStringList([
    ...mediaUrls,
    ...(params.toolMediaSelectionUrls ?? []),
  ]);
  if (explicitSelection) {
    mediaUrls = normalizeUniqueTrimmedStringList(params.toolMediaSelectionUrls).filter((url) =>
      eligibleUrls.has(url),
    );
  }
  const payloads = params.payloads?.length ? [...params.payloads] : [];
  const payloadIndex = payloads.findIndex((payload) => !payload.isReasoning && !payload.isError);
  const visiblePayload = payloads[payloadIndex];
  const isSourceReplyTranscriptMirror =
    params.sourceReplyDeliveryMode === "message_tool_only" &&
    visiblePayload &&
    getReplyPayloadMetadata(visiblePayload)?.sourceReplyTranscriptMirror;
  const selectionIndexes = explicitSelection
    ? payloads.flatMap((payload, index) =>
        !payload.isReasoning &&
        !payload.isError &&
        !getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror
          ? [index]
          : [],
      )
    : !isSourceReplyTranscriptMirror && visiblePayload
      ? [payloadIndex]
      : [];
  for (const index of selectionIndexes) {
    const payload = payloads[index];
    if (!payload?.text || referenceUrls.length === 0) {
      continue;
    }
    const selected = splitMediaFromOutput(payload.text, {
      extractAudioDirectives: false,
      extractMediaDirectives: false,
      markdownImageAllowlist: referenceUrls,
    });
    if (selected.mediaUrls?.length) {
      if (!explicitSelection) {
        mediaUrls = normalizeUniqueTrimmedStringList(selected.mediaUrls).filter((url) =>
          eligibleUrls.has(url),
        );
      }
      payloads[index] = copyReplyPayloadMetadata(payload, {
        ...payload,
        text: selected.text,
      });
    }
  }
  return { payloads, mediaUrls, payloadIndex, isSourceReplyTranscriptMirror };
}

/**
 * Merges media emitted by tools into the channel payloads produced by the
 * assistant turn. The first successful, non-reasoning reply owns the media so
 * text and attachments stay together; metadata is preserved for delivery bookkeeping.
 */
export function mergeAttemptToolMediaPayloads(
  params: ToolMediaMergeParams,
): EmbeddedRunPayload[] | undefined {
  return mergeSelectedToolMedia(params, selectToolMedia(params));
}

function mergeSelectedToolMedia(
  params: ToolMediaMergeParams,
  {
    payloads,
    mediaUrls,
    payloadIndex,
    isSourceReplyTranscriptMirror,
  }: ReturnType<typeof selectToolMedia>,
): EmbeddedRunPayload[] | undefined {
  const autoDeliveryMediaUrls = normalizeUniqueTrimmedStringList(params.toolAutoDeliveryMediaUrls);
  const hostOwnedInventory = new Set(
    normalizeUniqueTrimmedStringList(params.hostOwnedToolMediaUrls),
  );
  const hostOwnedMediaUrls = mediaUrls.filter((url) => hostOwnedInventory.has(url));
  if (
    mediaUrls.length === 0 &&
    autoDeliveryMediaUrls.length === 0 &&
    !params.toolAudioAsVoice &&
    !params.toolTrustedLocalMedia
  ) {
    const unchanged =
      payloads.length === (params.payloads?.length ?? 0) &&
      payloads.every((payload, index) => payload === params.payloads?.[index]);
    return unchanged ? params.payloads : payloads;
  }

  const buildMediaPayload = (urls: string[], includeAudio: boolean): EmbeddedRunPayload => ({
    mediaUrls: urls.length ? urls : undefined,
    mediaUrl: urls[0],
    audioAsVoice: (includeAudio && params.toolAudioAsVoice) || undefined,
    trustedLocalMedia: params.toolTrustedLocalMedia || undefined,
  });
  const shouldSplitHostOwnedMedia =
    params.sourceReplyDeliveryMode === "message_tool_only" && hostOwnedMediaUrls.length > 0;
  const hostOwnedMediaUrlSet = new Set(hostOwnedMediaUrls);
  const autoDeliveryOnlyMediaUrls = autoDeliveryMediaUrls.filter(
    (url) => !hostOwnedMediaUrlSet.has(url),
  );
  const shouldSplitAutoDeliveryMedia =
    params.sourceReplyDeliveryMode === "message_tool_only" && autoDeliveryOnlyMediaUrls.length > 0;
  const autoDeliveryMediaUrlSet = new Set(autoDeliveryMediaUrls);
  const mergeableMediaUrls =
    shouldSplitHostOwnedMedia || shouldSplitAutoDeliveryMedia
      ? mediaUrls.filter(
          (url) => !hostOwnedMediaUrlSet.has(url) && !autoDeliveryMediaUrlSet.has(url),
        )
      : mediaUrls;
  const appendOwnedMedia = (nextPayloads: EmbeddedRunPayload[]): EmbeddedRunPayload[] => {
    const withHostOwnedMedia = !shouldSplitHostOwnedMedia
      ? nextPayloads
      : [
          ...nextPayloads,
          markReplyPayloadForSourceSuppressionDelivery(
            buildMediaPayload(hostOwnedMediaUrls, false),
          ),
        ];
    if (!shouldSplitAutoDeliveryMedia) {
      return withHostOwnedMedia;
    }
    // Contract-owned media remains separate from private assistant text and
    // generic tool media so only its explicit provenance bypasses suppression.
    return [
      ...withHostOwnedMedia,
      markReplyPayloadForSourceSuppressionDelivery({
        ...buildMediaPayload(autoDeliveryOnlyMediaUrls, true),
        trustedLocalMedia: true,
      }),
    ];
  };

  // A transcript mirror is already delivered; every batch observes the same
  // exclusion, including media projected separately from the mirrored payload.
  if (isSourceReplyTranscriptMirror) {
    return appendOwnedMedia(payloads);
  }

  const payload = payloads[payloadIndex];
  if (payload) {
    if (
      mergeableMediaUrls.length === 0 &&
      (shouldSplitHostOwnedMedia || shouldSplitAutoDeliveryMedia)
    ) {
      return appendOwnedMedia(payloads);
    }
    const mergedMediaUrls = Array.from(
      new Set([...(payload.mediaUrls ?? []), ...mergeableMediaUrls]),
    );
    payloads[payloadIndex] = copyReplyPayloadMetadata(payload, {
      ...payload,
      mediaUrls: mergedMediaUrls.length ? mergedMediaUrls : undefined,
      mediaUrl: payload.mediaUrl ?? mergedMediaUrls[0],
      audioAsVoice: payload.audioAsVoice || params.toolAudioAsVoice || undefined,
      trustedLocalMedia: payload.trustedLocalMedia || params.toolTrustedLocalMedia || undefined,
    });
    return appendOwnedMedia(payloads);
  }

  // Reasoning-only turns still need a concrete media payload so channel delivery sees the attachment.
  const needsMediaPayload =
    mergeableMediaUrls.length > 0 || (!shouldSplitHostOwnedMedia && !shouldSplitAutoDeliveryMedia);
  return appendOwnedMedia(
    needsMediaPayload ? [...payloads, buildMediaPayload(mergeableMediaUrls, true)] : payloads,
  );
}

/** Keeps unsent artifacts with the logical run while their plugin generation retires. */
export function createPendingToolMediaCarry() {
  const batches: ToolMediaBatch[] = [];
  return {
    capture(attempt: ToolMediaBatch): void {
      if (
        !attempt.toolMediaUrls?.length &&
        attempt.toolMediaSelectionUrls === undefined &&
        !attempt.toolAudioAsVoice
      ) {
        return;
      }
      batches.push(
        copyCoreTtsAttemptResultProvenance(attempt, {
          toolMediaUrls: attempt.toolMediaUrls
            ? Object.freeze([...attempt.toolMediaUrls])
            : undefined,
          toolMediaSelectionUrls: attempt.toolMediaSelectionUrls
            ? Object.freeze([...attempt.toolMediaSelectionUrls])
            : undefined,
          hostOwnedToolMediaUrls: attempt.hostOwnedToolMediaUrls
            ? Object.freeze([...attempt.hostOwnedToolMediaUrls])
            : undefined,
          toolAudioAsVoice: attempt.toolAudioAsVoice,
          toolTrustedLocalMedia: attempt.toolTrustedLocalMedia,
        }),
      );
    },
    merge(
      this: void,
      params: ToolMediaMergeParams,
      operationalRunInstance?: object,
    ): EmbeddedRunPayload[] | undefined {
      if (batches.length === 0) {
        return mergeAttemptToolMediaPayloads(params);
      }
      const pending = batches.map((batch) => ({
        ...batch,
        toolAutoDeliveryMediaUrls: getCoreTtsAttemptResultMediaUrls(
          batch,
          batch.toolMediaUrls,
          operationalRunInstance,
        ),
      }));
      const allBatches = [...pending, params];
      const selectionIntent =
        params.toolMediaSelectionUrls ??
        batches.findLast((batch) => batch.toolMediaSelectionUrls !== undefined)
          ?.toolMediaSelectionUrls;
      const selected = selectToolMedia({
        ...params,
        toolMediaUrls: allBatches.flatMap((batch) => batch.toolMediaUrls ?? []),
        toolMediaSelectionUrls: selectionIntent,
      });
      const selectedUrls = new Set(selected.mediaUrls);
      const projected = allBatches.map((batch) =>
        Object.assign({}, batch, {
          hadMedia: Boolean(batch.toolMediaUrls?.length || batch.toolAutoDeliveryMediaUrls?.length),
          toolMediaUrls: normalizeUniqueTrimmedStringList(batch.toolMediaUrls).filter((url) =>
            selectedUrls.has(url),
          ),
        }),
      );
      const owners = new Map<string, (typeof projected)[number]>();
      // Keep the existing host-before-TTS-before-generic projection for an
      // artifact appearing in multiple batches, without combining their flags.
      for (const field of [
        "hostOwnedToolMediaUrls",
        "toolAutoDeliveryMediaUrls",
        "toolMediaUrls",
      ] as const) {
        for (const batch of projected) {
          for (const raw of batch[field] ?? []) {
            const url = raw.trim();
            if (
              (field !== "hostOwnedToolMediaUrls" || batch.toolMediaUrls.includes(url)) &&
              !owners.has(url)
            ) {
              owners.set(url, batch);
            }
          }
        }
      }
      const deliveries = projected.map((batch) => ({
        batch,
        mediaUrls: batch.toolMediaUrls.filter((url) => owners.get(url) === batch),
        toolAutoDeliveryMediaUrls: batch.toolAutoDeliveryMediaUrls?.filter(
          (url) => owners.get(url.trim()) === batch,
        ),
      }));
      if (selectionIntent !== undefined) {
        const ordered: typeof deliveries = [];
        for (const url of selected.mediaUrls) {
          const batch = owners.get(url);
          if (!batch) {
            continue;
          }
          const previous = ordered.at(-1);
          if (previous?.batch === batch) {
            previous.mediaUrls.push(url);
          } else {
            ordered.push({ batch, mediaUrls: [url], toolAutoDeliveryMediaUrls: undefined });
          }
        }
        for (const delivery of ordered) {
          delivery.toolAutoDeliveryMediaUrls = delivery.batch.toolAutoDeliveryMediaUrls?.filter(
            (url) =>
              owners.get(url.trim()) === delivery.batch && delivery.mediaUrls.includes(url.trim()),
          );
        }
        // Explicit reference order can interleave origins. Each contiguous group
        // keeps its original provenance; contract-only media retains its own batch.
        for (const delivery of deliveries) {
          const remaining = delivery.toolAutoDeliveryMediaUrls?.filter(
            (url) => !selectedUrls.has(url.trim()),
          );
          if (remaining?.length) {
            ordered.push({ ...delivery, mediaUrls: [], toolAutoDeliveryMediaUrls: remaining });
          }
        }
        deliveries.splice(0, deliveries.length, ...ordered);
      }
      const visible = selected.payloads[selected.payloadIndex];
      // Existing assistant media has its own provenance; carried media must
      // not promote it with another origin's trusted-local or voice flags.
      let payloads: EmbeddedRunPayload[] | undefined;
      if (visible?.mediaUrl || visible?.mediaUrls?.length) {
        payloads = selected.payloads;
      }
      if (visible && payloads && !selected.isSourceReplyTranscriptMirror) {
        const mediaUrl =
          visible.mediaUrl && !owners.has(visible.mediaUrl.trim()) ? visible.mediaUrl : undefined;
        const mediaUrls = visible.mediaUrls?.filter((url) => !owners.has(url.trim()));
        if (mediaUrl !== visible.mediaUrl || mediaUrls?.length !== visible.mediaUrls?.length) {
          // The source batch owns this exact artifact's flags. Leave unrelated
          // assistant media in place and carry its delivery metadata unchanged.
          payloads[selected.payloadIndex] = copyReplyPayloadMetadata(visible, {
            ...visible,
            mediaUrl,
            mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
            ...(!mediaUrl && !mediaUrls?.length
              ? { audioAsVoice: undefined, trustedLocalMedia: undefined }
              : {}),
          });
        }
      }
      for (const { batch, mediaUrls, toolAutoDeliveryMediaUrls } of deliveries) {
        const owned = (urls: readonly string[] | undefined) =>
          urls?.filter((url) => owners.get(url.trim()) === batch);
        if (batch.hadMedia && mediaUrls.length === 0 && !toolAutoDeliveryMediaUrls?.length) {
          continue;
        }
        const first = payloads === undefined;
        // Selection is shared, but each origin keeps its own trust, voice and
        // suppression provenance. Combining flags would authorize unrelated media.
        const current = first
          ? selected
          : {
              payloads: [],
              payloadIndex: -1,
              isSourceReplyTranscriptMirror: selected.isSourceReplyTranscriptMirror,
            };
        const next = mergeSelectedToolMedia(
          {
            ...batch,
            toolAutoDeliveryMediaUrls,
            hostOwnedToolMediaUrls: owned(batch.hostOwnedToolMediaUrls),
            payloads: first ? selected.payloads : undefined,
            sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
          },
          {
            ...current,
            mediaUrls,
          },
        );
        payloads = payloads === undefined ? next : [...payloads, ...(next ?? [])];
      }
      const emptied = payloads?.[selected.payloadIndex];
      if (
        payloads &&
        visible &&
        emptied &&
        !hasReplyPayloadContent(emptied, {
          extraContent: emptied.audioAsVoice,
        })
      ) {
        const originalUrls = new Set(
          [...(visible.mediaUrls ?? []), ...(visible.mediaUrl ? [visible.mediaUrl] : [])].map(
            (url) => url.trim(),
          ),
        );
        const replacement = payloads.find(
          (payload, index) =>
            index >= selected.payloads.length &&
            [...(payload.mediaUrls ?? []), ...(payload.mediaUrl ? [payload.mediaUrl] : [])].some(
              (url) => originalUrls.has(url),
            ),
        );
        if (replacement) {
          // The media-only original no longer reaches normalization or delivery.
          // Move its transcript/completion ownership to one surviving source batch.
          copyReplyPayloadMetadata(visible, replacement);
          payloads.splice(selected.payloadIndex, 1);
        }
      }
      return payloads ?? selected.payloads;
    },
    clear(): void {
      batches.length = 0;
    },
  };
}
