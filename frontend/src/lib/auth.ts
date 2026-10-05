import { getAccessToken as privyAccessToken } from '@privy-io/react-auth';
import { isDemo } from './demo';

// The bearer token for API calls: Privy's, or a stand-in in demo mode (where
// the API layer answers locally and never sends it anywhere).
export const getAccessToken = async (): Promise<string | null> => isDemo() ? 'demo' : privyAccessToken();
