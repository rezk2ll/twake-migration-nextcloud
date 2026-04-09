export interface ClouderyClient {
  getToken(workplaceFqdn: string): Promise<string>
}

export function createClouderyClient(
  clouderyUrl: string,
  clouderyToken: string
): ClouderyClient {
  return {
    async getToken(workplaceFqdn: string): Promise<string> {
      const url = `${clouderyUrl}/api/public/instances/${workplaceFqdn}/nextcloud_migration_token`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clouderyToken}`,
        },
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(
          `Cloudery token request failed (${response.status}): ${body}`
        )
      }

      const data = (await response.json()) as { token: string }
      return data.token
    },
  }
}
