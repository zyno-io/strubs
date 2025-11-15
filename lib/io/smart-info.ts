import { createLogger } from '../log';
import { smartctl as defaultSmartctl } from './helpers';

type SmartInfoDeps = {
    smartctl: typeof defaultSmartctl;
    createLogger: typeof createLogger;
};

const defaultDeps: SmartInfoDeps = {
    smartctl: defaultSmartctl,
    createLogger
};

export class SmartInfoService {
    private readonly deps: SmartInfoDeps;
    private readonly log: ReturnType<typeof createLogger>;

    constructor(deps?: Partial<SmartInfoDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('smart-info');
    }

    async fetch(path: string): Promise<{ serial_number?: string } | null> {
        let tries = 0;
        while (true) {
            try {
                this.log('querying SMART info for ' + path);
                const info = await this.deps.smartctl('-i', path);
                return info as { serial_number?: string };
            }

            catch (err) {
                if (!(err instanceof SyntaxError)) {
                    this.log(`failed to fetch SMART info for ${path}:`, err);
                    return null;
                }

                this.log('error parsing SMART info for ' + path);
                tries++;

                if (tries === 3) {
                    this.log(`max tries exceeded for ${path}`);
                    return null;
                }
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

export const smartInfoService = new SmartInfoService();
