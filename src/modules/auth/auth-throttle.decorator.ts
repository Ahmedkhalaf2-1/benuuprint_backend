import { SetMetadata } from '@nestjs/common';

export const AUTH_THROTTLE_KEY = 'auth:throttled';

export const TRACKING_THROTTLE_KEY = 'tracking:throttled';

/** Opt a public route into the per-IP "tracking" rate limit (order tracking links). */
export const TrackingThrottle = () => SetMetadata(TRACKING_THROTTLE_KEY, true);

export const CUSTOMER_ACTION_THROTTLE_KEY = 'customer:action-throttled';

/** Opt a customer-portal route (upload, submit) into the per-IP "customerAction" rate limit. */
export const CustomerActionThrottle = () =>
  SetMetadata(CUSTOMER_ACTION_THROTTLE_KEY, true);

/** Opt a route into the strict per-IP "auth" rate limit (login, refresh). */
export const AuthThrottle = () => SetMetadata(AUTH_THROTTLE_KEY, true);
