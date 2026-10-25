import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { KnowledgeBasesService, type DocumentUpdate, type KnowledgeBaseUpdate } from "./knowledge-bases.service";

interface CreateKnowledgeBaseBody {
  name?: string;
  /** "crawl" (default) or "documents". */
  sourceType?: string;
  sourceUrl?: string;
  /** "crawl" only: "daily" | "weekly" | null. */
  autoSync?: unknown;
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
      body.autoSync,
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

  // Static paths, also before ":id".
  @Get("documents")
  @RequirePermission("knowledge:read")
  async allDocuments(
    @Req() request: { businessContext: BusinessContext },
    @Query("knowledgeBaseId") knowledgeBaseId?: string,
    @Query("type") type?: string,
    @Query("status") status?: string,
    @Query("q") q?: string,
  ) {
    return this.knowledgeBasesService.listAllDocuments(request.businessContext.businessId, { knowledgeBaseId, type, status, q });
  }

  @Get("sources")
  @RequirePermission("knowledge:read")
  async sources(@Req() request: { businessContext: BusinessContext }) {
    return this.knowledgeBasesService.listSources(request.businessContext.businessId);
  }

  @Get(":id")
  @RequirePermission("knowledge:read")
  async get(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    return this.knowledgeBasesService.get(request.businessContext.businessId, id);
  }

  @Patch(":id")
  @RequirePermission("knowledge:write")
  async update(
    @Req() request: { businessContext: BusinessContext },
    @Param("id") id: string,
    @Body() body: KnowledgeBaseUpdate,
  ) {
    return this.knowledgeBasesService.update(request.businessContext.businessId, id, body ?? {});
  }

  @Post(":id/sync")
  @RequirePermission("knowledge:write")
  async sync(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    return this.knowledgeBasesService.sync(request.businessContext.businessId, id);
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

  @Get(":id/documents/:documentId")
  @RequirePermission("knowledge:read")
  async getDocument(
    @Req() request: { businessContext: BusinessContext },
    @Param("id") id: string,
    @Param("documentId") documentId: string,
  ) {
    return this.knowledgeBasesService.getDocument(request.businessContext.businessId, id, documentId);
  }

  @Patch(":id/documents/:documentId")
  @RequirePermission("knowledge:write")
  async updateDocument(
    @Req() request: { businessContext: BusinessContext },
    @Param("id") id: string,
    @Param("documentId") documentId: string,
    @Body() body: DocumentUpdate,
  ) {
    return this.knowledgeBasesService.updateDocument(request.businessContext.businessId, id, documentId, body ?? {});
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
