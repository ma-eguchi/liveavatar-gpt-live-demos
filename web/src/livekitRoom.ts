/**
 * Raw `livekit-client` join — the avatar's face and voice arrive here.
 *
 * Not the LiveAvatar web SDK: the SDK assumes the browser starts the session
 * and holds the session token, and here the orchestrator starts it server-side
 * (it needs the `ws_url` from /v1/sessions/start for the media leg). All the
 * browser has to do is join the room and attach whatever the avatar publishes.
 */
import { Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";

export interface AvatarRoom {
  disconnect: () => Promise<void>;
}

export async function joinAvatarRoom(
  url: string,
  token: string,
  elements: { video: HTMLVideoElement; audio: HTMLAudioElement },
  signal?: AbortSignal,
): Promise<AvatarRoom> {
  const room = new Room({ adaptiveStream: true, dynacast: true });

  const attach = (track: RemoteTrack) => {
    if (signal?.aborted) return;
    if (track.kind === Track.Kind.Video) track.attach(elements.video);
    if (track.kind === Track.Kind.Audio) track.attach(elements.audio);
  };

  room.on(RoomEvent.TrackSubscribed, attach);
  room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => track.detach());

  const abort = () => {
    void room.disconnect();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new DOMException("Canceled", "AbortError");
    await room.connect(url, token);
    if (signal?.aborted) throw new DOMException("Canceled", "AbortError");
  } catch (error) {
    signal?.removeEventListener("abort", abort);
    room.removeAllListeners();
    await room.disconnect();
    throw error;
  }

  // Tracks published before we finished connecting fire no TrackSubscribed, so
  // the avatar would stay black until it happened to republish.
  room.remoteParticipants.forEach((participant) => {
    participant.trackPublications.forEach((publication) => {
      if (publication.track) attach(publication.track as RemoteTrack);
    });
  });

  // Browsers block autoplay until a gesture. The session starts from a click,
  // so this normally resolves — but it must not take the join down if it fails.
  try {
    await room.startAudio();
  } catch {
    // The avatar is still visible; audio unblocks on the next interaction.
  }

  return {
    disconnect: async () => {
      signal?.removeEventListener("abort", abort);
      room.removeAllListeners();
      await room.disconnect();
    },
  };
}
