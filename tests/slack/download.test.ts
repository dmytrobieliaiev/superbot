import { describe, expect, it } from 'vitest';
import { isSupportedAudio, isSupportedImage } from '../../src/slack/download.js';

describe('isSupportedImage', () => {
  it('accepts common image mimes', () => {
    expect(isSupportedImage('image/png')).toBe(true);
    expect(isSupportedImage('image/jpeg')).toBe(true);
    expect(isSupportedImage('image/jpg')).toBe(true);
    expect(isSupportedImage('image/webp')).toBe(true);
    expect(isSupportedImage('image/gif')).toBe(true);
  });

  it('case-insensitive', () => {
    expect(isSupportedImage('IMAGE/PNG')).toBe(true);
  });

  it('rejects non-image', () => {
    expect(isSupportedImage('application/pdf')).toBe(false);
    expect(isSupportedImage('audio/mp3')).toBe(false);
    expect(isSupportedImage('image/svg+xml')).toBe(false); // we deliberately exclude svg
  });
});

describe('isSupportedAudio', () => {
  it('accepts common voice/audio mimes', () => {
    expect(isSupportedAudio('audio/webm')).toBe(true);
    expect(isSupportedAudio('audio/mp4')).toBe(true);
    expect(isSupportedAudio('audio/m4a')).toBe(true);
    expect(isSupportedAudio('audio/mpeg')).toBe(true);
    expect(isSupportedAudio('audio/mp3')).toBe(true);
    expect(isSupportedAudio('audio/wav')).toBe(true);
    expect(isSupportedAudio('audio/x-wav')).toBe(true);
    expect(isSupportedAudio('audio/ogg')).toBe(true);
    expect(isSupportedAudio('audio/flac')).toBe(true);
  });

  it('rejects non-audio', () => {
    expect(isSupportedAudio('image/png')).toBe(false);
    expect(isSupportedAudio('video/mp4')).toBe(false);
  });
});
