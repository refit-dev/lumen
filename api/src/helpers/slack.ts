import { getSecretOrEnvVar } from "./secrets";

export async function slackLog(message: string) {
  const slackWebhook = await getSecretOrEnvVar({
    secretNameTemplate: "lumen/*/slack-webhook",
    envVariableName: "SLACK_WEBHOOK",
    throwOnDevError: false,
    throwOnStagingOrProdError: true,
  });

  if (!slackWebhook) {
    return;
  }

  await fetch(slackWebhook, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: message,
    }),
  });
}
