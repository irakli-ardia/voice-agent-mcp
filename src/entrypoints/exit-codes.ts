export const EXIT_OK = 0;

/** Every typed failure without a more specific code below. */
export const EXIT_FAILURE = 1;

/** Command-line usage, and input the user can correct before any provider is used. */
export const EXIT_USAGE = 64;

export const EXIT_UNAVAILABLE = 69;

export const EXIT_SOFTWARE = 70;

export const EXIT_TEMPFAIL = 75;

export const EXIT_CONFIG = 78;

/** 128 + SIGINT, as shells report an interrupted command. */
export const EXIT_INTERRUPTED = 130;

/** 128 + SIGTERM, as shells report a terminated command. */
export const EXIT_TERMINATED = 143;
