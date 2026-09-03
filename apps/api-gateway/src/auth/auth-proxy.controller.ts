import { Body, Controller, Get, HttpException, Headers, Post } from "@nestjs/common";
import axios, { AxiosError } from "axios";
import { loadServiceConfig } from "@platform/shared-config";

// api-gateway is the only publicly reachable service; it proxies auth
// requests to identity-service rather than exposing it directly.
@Controller("auth")
export class AuthProxyController {
  private readonly identityServiceUrl = loadServiceConfig("api-gateway", 3010).identityServiceUrl;

  @Post("login")
  async login(@Body() body: unknown) {
    return this.forward("post", "/auth/login", body);
  }

  @Get("me")
  async me(@Headers("authorization") authorization?: string) {
    return this.forward("get", "/auth/me", undefined, authorization);
  }

  private async forward(method: "get" | "post", path: string, data?: unknown, authorization?: string) {
    try {
      const response = await axios.request({
        method,
        url: `${this.identityServiceUrl}${path}`,
        data,
        headers: authorization ? { Authorization: authorization } : undefined,
      });
      return response.data;
    } catch (err) {
      const error = err as AxiosError;
      throw new HttpException(
        (error.response?.data as object) ?? { message: "Upstream service error" },
        error.response?.status ?? 502,
      );
    }
  }
}
