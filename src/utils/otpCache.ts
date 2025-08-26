import NodeCache from "node-cache";

export const otpCache = new NodeCache({ stdTTL: 300 }); // 5 minutes
