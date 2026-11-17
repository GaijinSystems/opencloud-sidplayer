/**
 * C shim around libsidplayfp for the WebAssembly build.
 *
 * Exposes exactly what `public/vendor/sid-engine/engine.js` needs, as plain C
 * functions with integer and pointer arguments: no Embind, no JavaScript glue,
 * so the module can be instantiated in an AudioWorkletGlobalScope with only
 * the WASI stubs the adapter provides, and the content security policy needs
 * 'wasm-unsafe-eval' but not 'unsafe-eval'.
 *
 * Handles are opaque pointers. Errors are reported by return value with the
 * message retrievable from sid_error(); the string stays valid until the
 * next call that can fail.
 *
 * Built against libsidplayfp 2.6.x. See build.sh.
 */

#include <cstdint>
#include <cstring>
#include <memory>
#include <string>

#include <sidplayfp/SidConfig.h>
#include <sidplayfp/SidInfo.h>
#include <sidplayfp/SidTune.h>
#include <sidplayfp/SidTuneInfo.h>
#include <sidplayfp/builders/residfp.h>
#include <sidplayfp/sidplayfp.h>

namespace {

std::string g_error;

void setError(const char* what) {
  g_error = (what && *what) ? what : "unknown error";
}

constexpr std::size_t KERNAL_SIZE = 8192;
constexpr std::size_t BASIC_SIZE = 8192;
constexpr std::size_t CHARGEN_SIZE = 4096;

struct Engine {
  // Declaration order is destruction order reversed, and the player outlives
  // nothing here by accident. `builder` owns the emulated SID chips, and
  // ReSIDfpBuilder's destructor removes them; `player`'s Mixer and C64 banks
  // hold raw pointers to those same chips until player.config() is told
  // otherwise. Declared the other way round, builder was destroyed first and
  // player was left pointing at freed chips for the rest of its own
  // destruction. Harmless with libsidplayfp 2.6.0, whose Player destructor is
  // empty, and a use-after-free the day that changes. `tune` is the same kind
  // of raw-pointer loan, and sid_destroy below clears it explicitly with
  // player.load(nullptr) before any of this runs.
  std::unique_ptr<ReSIDfpBuilder> builder;
  sidplayfp player;
  SidConfig config;
  std::unique_ptr<SidTune> tune;
  // libsidplayfp copies ROM images into its own banks, but the copies here
  // make the ownership obvious and cost nothing worth measuring.
  std::unique_ptr<uint8_t[]> kernal;
  std::unique_ptr<uint8_t[]> basic;
  std::unique_ptr<uint8_t[]> chargen;
};

std::unique_ptr<uint8_t[]> copyRom(const uint8_t* src, std::size_t size) {
  if (!src) return nullptr;
  std::unique_ptr<uint8_t[]> out(new uint8_t[size]);
  std::memcpy(out.get(), src, size);
  return out;
}

}  // namespace

extern "C" {

/** The last error message. Empty when nothing has failed yet. */
const char* sid_error() {
  return g_error.c_str();
}

/** libsidplayfp's own version string. */
const char* sid_version(Engine* e) {
  return e ? e->player.info().version() : "";
}

/**
 * Creates an engine producing interleaved stereo at `sampleRate`.
 * Returns nullptr on failure; see sid_error().
 */
Engine* sid_create(int sampleRate) {
  if (sampleRate < 8000 || sampleRate > 192000) {
    setError("unsupported sample rate");
    return nullptr;
  }

  std::unique_ptr<Engine> e(new Engine());

  e->builder.reset(new ReSIDfpBuilder("ReSIDfp"));
  // One emulated chip per SID the engine can address, so 2SID and 3SID
  // tunes have the hardware they expect.
  e->builder->create(e->player.info().maxsids());
  if (!e->builder->getStatus()) {
    setError(e->builder->error());
    return nullptr;
  }
  e->builder->filter(true);
  /*
   * Middle of both filter curves.
   *
   * Both parameters are positions from 0.0 to 1.0, default 0.5. The public
   * header documents the 8580 one as "curve center frequency (default
   * 12500)", which is stale - reSIDfp took a frequency there long ago, and
   * Filter8580::setFilterCurve now reads it as a position:
   *
   *     // 1.2 <= cp <= 1.8
   *     cp = 1.8 - curvePosition * 3./5.;
   *
   * Nothing clamps it, so 12500 gave cp = -7498.2 and an 8580 filter made of
   * nonsense: every tune that asked for an 8580 saturated at full scale, and
   * about seven in ten collapsed to a constant after half a second. They all
   * played correctly if the user forced a 6581, which is what made it look
   * like a chip-specific quirk rather than a bad parameter.
   */
  e->builder->filter6581Curve(0.5);
  e->builder->filter8580Curve(0.5);

  SidConfig cfg = e->player.config();
  cfg.frequency = static_cast<uint_least32_t>(sampleRate);
  cfg.samplingMethod = SidConfig::INTERPOLATE;
  cfg.fastSampling = false;
  cfg.playback = SidConfig::STEREO;
  // Defaults for tunes whose header does not say. Never forced: the header,
  // when it speaks, is right more often than any global setting.
  cfg.defaultC64Model = SidConfig::PAL;
  cfg.forceC64Model = false;
  cfg.defaultSidModel = SidConfig::MOS6581;
  cfg.forceSidModel = false;
  cfg.digiBoost = false;
  cfg.sidEmulation = e->builder.get();
  if (!e->player.config(cfg)) {
    setError(e->player.error());
    return nullptr;
  }
  e->config = cfg;

  return e.release();
}

void sid_destroy(Engine* e) {
  if (!e) return;
  e->player.stop();
  e->player.load(nullptr);
  delete e;
}

/**
 * Supplies C64 ROM images. Any pointer may be null. Sizes are fixed:
 * kernal 8192, basic 8192, chargen 4096 bytes; the caller checks them.
 */
void sid_set_roms(Engine* e, const uint8_t* kernal, const uint8_t* basic, const uint8_t* chargen) {
  if (!e) return;
  e->kernal = copyRom(kernal, KERNAL_SIZE);
  e->basic = copyRom(basic, BASIC_SIZE);
  e->chargen = copyRom(chargen, CHARGEN_SIZE);
  e->player.setRoms(e->kernal.get(), e->basic.get(), e->chargen.get());
}

/**
 * Loads a whole SID file and selects a subsong (1-based; 0 means the
 * tune's default). Returns the subsong actually selected, or -1 on failure.
 * Emulation state is fully reset; calling this again is how a restart or a
 * subsong change is done.
 */
int sid_load(Engine* e, const uint8_t* data, uint32_t length, int subsong) {
  if (!e || !data || length == 0) {
    setError("no data");
    return -1;
  }

  std::unique_ptr<SidTune> tune(new SidTune(data, length));
  if (!tune->getStatus()) {
    setError(tune->statusString());
    return -1;
  }
  const unsigned int selected = tune->selectSong(subsong < 0 ? 0 : static_cast<unsigned int>(subsong));

  e->player.stop();
  if (!e->player.load(tune.get())) {
    setError(e->player.error());
    // Leave the previous tune loaded rather than pointing the player at a
    // tune we are about to destroy.
    if (e->tune) e->player.load(e->tune.get());
    return -1;
  }
  // Re-apply the configuration so the emulated chips match this tune's
  // header (model, clock, number of SIDs).
  //
  // Still not committed: the new tune stays in the local unique_ptr until this
  // succeeds. Committing first meant a config failure returned -1 with e->tune
  // already pointing at the new tune, so the JS caller threw and reported that
  // nothing had loaded while the engine held a loaded, misconfigured tune that
  // would render the moment anything unpaused it. Failure restores the
  // previous tune exactly as the load path above does.
  if (!e->player.config(e->config)) {
    setError(e->player.error());
    e->player.load(e->tune ? e->tune.get() : nullptr);
    return -1;
  }

  // The player holds a raw pointer to the tune, so the old one is released
  // only now that the player has been pointed at the new one for good.
  e->tune = std::move(tune);
  return static_cast<int>(selected);
}

/**
 * Renders `frames` stereo frames of interleaved 16-bit PCM into `out`, which
 * must hold frames * 2 samples. Returns the number of frames produced, or -1
 * on failure. Fewer than requested means the player stopped; see sid_error().
 */
int sid_render(Engine* e, int16_t* out, int frames) {
  if (!e || !out || frames <= 0) return 0;
  if (!e->tune) {
    setError("no tune loaded");
    return -1;
  }
  const uint_least32_t wanted = static_cast<uint_least32_t>(frames) * 2;
  const uint_least32_t got = e->player.play(out, wanted);
  if (got < wanted && !e->player.isPlaying()) {
    setError(e->player.error());
    return -1;
  }
  return static_cast<int>(got / 2);
}

/**
 * Makes `next` the configuration, and keeps it only if the player accepts it.
 *
 * libsidplayfp puts its own state back when it refuses a configuration, but
 * the copy kept here is what `sid_load` applies to every later tune - so
 * keeping a refused one would make every load after it fail the same way,
 * until the page was reloaded.
 */
static int applyConfig(Engine* e, const SidConfig& next) {
  if (e->tune && !e->player.config(next)) {
    setError(e->player.error());
    return -1;
  }
  e->config = next;
  return 0;
}

/**
 * Chooses the SID chip: 1 = MOS6581, 2 = MOS8580; `force` makes it override
 * what the tune's header says, otherwise it only fills in for headers that
 * do not say. libsidplayfp rebuilds the emulated chips and restarts the tune
 * when a loaded tune is affected, so the caller should expect position 0.
 */
int sid_set_model(Engine* e, int model, int force) {
  if (!e) return -1;
  SidConfig next = e->config;
  next.defaultSidModel = model == 2 ? SidConfig::MOS8580 : SidConfig::MOS6581;
  next.forceSidModel = force != 0;
  return applyConfig(e, next);
}

/** Chooses the machine: 1 = PAL, 2 = NTSC; `force` as for sid_set_model. */
int sid_set_clock(Engine* e, int clock, int force) {
  if (!e) return -1;
  SidConfig next = e->config;
  next.defaultC64Model = clock == 2 ? SidConfig::NTSC : SidConfig::PAL;
  next.forceC64Model = force != 0;
  return applyConfig(e, next);
}

/** Seconds of emulated time since the last load, as libsidplayfp counts it. */
uint32_t sid_time(Engine* e) {
  return e ? e->player.time() : 0;
}

/** Mutes or unmutes one voice (0..2) of one SID (0..2). Returns 0, or -1 for bad indices. */
int sid_mute(Engine* e, int sid, int voice, int mute) {
  if (!e || sid < 0 || sid > 2 || voice < 0 || voice > 2) return -1;
  e->player.mute(static_cast<unsigned int>(sid), static_cast<unsigned int>(voice), mute != 0);
  return 0;
}

}  // extern "C"
