/**
 * Voice store — TTS/mic state setters and persistence config.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useVoiceStore } from '../stores/voice';

describe('Voice store', () => {
  beforeEach(() => {
    useVoiceStore.setState({
      ttsAutoSpeak: false, ttsRatePct: 25, micSticky: false, micState: 'idle',
      vadActive: false, ttsPlaying: false, ttsSpeakingId: null,
      speakBlockSpoken: false, micDeviceId: '', speakerDeviceId: '',
    });
  });

  it('setTtsAutoSpeak toggles', () => {
    useVoiceStore.getState().setTtsAutoSpeak(true);
    expect(useVoiceStore.getState().ttsAutoSpeak).toBe(true);
  });

  it('setTtsRatePct sets playback rate', () => {
    useVoiceStore.getState().setTtsRatePct(50);
    expect(useVoiceStore.getState().ttsRatePct).toBe(50);
  });

  it('mic state transitions: idle -> recording -> transcribing -> idle', () => {
    useVoiceStore.getState().setMicState('recording');
    expect(useVoiceStore.getState().micState).toBe('recording');
    useVoiceStore.getState().setMicState('transcribing');
    expect(useVoiceStore.getState().micState).toBe('transcribing');
    useVoiceStore.getState().setMicState('idle');
    expect(useVoiceStore.getState().micState).toBe('idle');
  });

  it('TTS playing state tracks which message', () => {
    useVoiceStore.getState().setTtsPlaying(true);
    useVoiceStore.getState().setTtsSpeakingId('msg-123');
    expect(useVoiceStore.getState().ttsPlaying).toBe(true);
    expect(useVoiceStore.getState().ttsSpeakingId).toBe('msg-123');
  });

  it('supports streaming sentinel for ttsSpeakingId', () => {
    useVoiceStore.getState().setTtsSpeakingId('__streaming__');
    expect(useVoiceStore.getState().ttsSpeakingId).toBe('__streaming__');
  });

  it('device IDs default to empty string', () => {
    expect(useVoiceStore.getState().micDeviceId).toBe('');
    expect(useVoiceStore.getState().speakerDeviceId).toBe('');
  });

  it('setMicDeviceId/setSpeakerDeviceId persist selection', () => {
    useVoiceStore.getState().setMicDeviceId('mic-abc');
    useVoiceStore.getState().setSpeakerDeviceId('spk-xyz');
    expect(useVoiceStore.getState().micDeviceId).toBe('mic-abc');
    expect(useVoiceStore.getState().speakerDeviceId).toBe('spk-xyz');
  });
});
