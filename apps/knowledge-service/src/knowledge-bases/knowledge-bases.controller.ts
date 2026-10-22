import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { KnowledgeBasesService } from "./knowledge-bases.service";

interface CreateKnowledgeBaseBody {
  name?: string;
  /** "crawl" (default) or "documents". */
  sourceType?: string;
  sourceUrl?: string;
}

interface SearchBody {
  query?: string;
  knowledgeBaseIds?: string[];
}

// Business comes from the token, so the path is fixed at "current" — same
// pattern as identity-service's members/invitations controllers.
@Controller("businesses/current/knowledge-bases")
export class KnowledgeBasesController {
  constructor(private readonly knowledgeBasesService: KnowledgeBasesService) {}

  @Post()
  @RequirePermission("knowledge:write")
  async create(
    @Req() request: { businessContext: BusinessContext },
    @Body() body: CreateKnowledgeBaseBody,
  ) {
    return this.knowledgeBasesService.create(
      request.businessContext.businessId,
      body.name ?? "",
      body.sourceType ?? "crawl",
      body.sourceUrl ?? "",
    );
  }

  @Get()
  @RequirePermission("knowledge:read")
  async list(@Req() request: { businessContext: BusinessContext }) {
    return this.knowledgeBasesService.list(request.businessContext.businessId);
  }

  // Registered before ":id" so "search" isn't swallowed as an id param.
  @Post("search")
  @RequirePermission("knowledge:read")
  async search(@Req() request: { businessContext: BusinessContext }, @Body() body: SearchBody) {
    return this.knowledgeBasesService.search(
      request.businessContext.businessId,
      body.knowledgeBaseIds ?? [],
      body.query ?? "",
    );
  }

  @Get(":id")
  @RequirePermission("knowledge:read")
  async get(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    return this.knowledgeBasesService.get(request.businessContext.businessId, id);
  }

  @Get(":id/products")
  @RequirePermission("knowledge:read")
  async products(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    return this.knowledgeBasesService.listProducts(request.businessContext.businessId, id);
  }

  @Get(":id/documents")
  @RequirePermission("knowledge:read")
  async documents(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    return this.knowledgeBasesService.listDocuments(request.businessContext.businessId, id);
  }

  @Post(":id/documents")
  @RequirePermission("knowledge:write")
  async addDocument(
    @Req() request: { businessContext: BusinessContext },
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.knowledgeBasesService.addDocument(request.businessContext.businessId, id, body ?? {});
  }

  @Post(":id/documents/:documentId/reprocess")
  @RequirePermission("knowledge:write")
  async reprocessDocument(
    @Req() request: { businessContext: BusinessContext },
    @Param("id") id: string,
    @Param("documentId") documentId: string,
  ) {
    return this.knowledgeBasesService.reprocessDocument(request.businessContext.businessId, id, documentId);
  }

  @Delete(":id/documents/:documentId")
  @HttpCode(204)
  @RequirePermission("knowledge:write")
  async removeDocument(
    @Req() request: { businessContext: BusinessContext },
    @Param("id") id: string,
    @Param("documentId") documentId: string,
  ) {
    await this.knowledgeBasesService.removeDocument(request.businessContext.businessId, id, documentId);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("knowledge:write")
  async remove(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    await this.knowledgeBasesService.remove(request.businessContext.businessId, id);
  }
}
