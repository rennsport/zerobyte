import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "~/server/db/db";
import { account, member, organization, sessionsTable, usersTable } from "~/server/db/schema";
import { authService } from "../auth.service";

function randomId() {
	return Bun.randomUUIDv7();
}

function randomSlug(prefix: string) {
	return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createUser(email: string) {
	const id = randomId();

	await db.insert(usersTable).values({
		id,
		email,
		name: email.split("@")[0],
		username: randomSlug("user"),
	});

	return id;
}

async function createOrganization(name: string) {
	const id = randomId();

	await db.insert(organization).values({
		id,
		name,
		slug: randomSlug("org"),
		createdAt: new Date(),
	});

	return id;
}

async function createMembership({
	userId,
	organizationId,
	role,
}: {
	userId: string;
	organizationId: string;
	role: "owner" | "admin" | "member";
}) {
	const id = randomId();
	await db.insert(member).values({ id, userId, organizationId, role, createdAt: new Date() });
	return id;
}

async function createSession({
	userId,
	activeOrganizationId,
}: {
	userId: string;
	activeOrganizationId: string | null;
}) {
	await db.insert(sessionsTable).values({
		id: randomId(),
		userId,
		token: randomSlug("token"),
		expiresAt: new Date(Date.now() + 60_000),
		activeOrganizationId,
	});
}

async function createAccount({ userId, providerId }: { userId: string; providerId: string }) {
	const id = randomId();

	await db.insert(account).values({
		id,
		accountId: randomSlug("account"),
		providerId,
		userId,
		password: providerId === "credential" ? "password-hash" : null,
	});

	return id;
}

describe("authService account and membership management", () => {
	beforeEach(async () => {
		await db.delete(account);
		await db.delete(member);
		await db.delete(sessionsTable);
		await db.delete(organization);
		await db.delete(usersTable);
	});

	test("deleteUserAccount removes the selected account and keeps existing sessions", async () => {
		const userId = await createUser(`${randomSlug("user")}@example.com`);
		const credentialAccountId = await createAccount({
			userId,
			providerId: "credential",
		});
		await createAccount({ userId, providerId: "oidc-acme" });
		await createSession({ userId, activeOrganizationId: null });

		const result = await authService.deleteUserAccount(userId, credentialAccountId);

		expect(result).toEqual({ lastAccount: false, notFound: false });

		const deletedAccount = await db.query.account.findFirst({
			where: { id: credentialAccountId },
			columns: { id: true },
		});
		const remainingSessions = await db.query.sessionsTable.findMany({
			where: { userId },
			columns: { id: true },
		});

		expect(deletedAccount).toBeUndefined();
		expect(remainingSessions).toHaveLength(1);
	});

	test("deleteUserAccount returns notFound when the account does not belong to the user", async () => {
		const userId = await createUser(`${randomSlug("user")}@example.com`);
		await createAccount({ userId, providerId: "credential" });
		await createAccount({ userId, providerId: "oidc-acme" });

		const result = await authService.deleteUserAccount(userId, randomId());

		expect(result).toEqual({ lastAccount: false, notFound: true });
	});

	test("deleteUserAccount refuses to delete when it is the user's last account", async () => {
		const userId = await createUser(`${randomSlug("user")}@example.com`);
		const onlyAccountId = await createAccount({
			userId,
			providerId: "credential",
		});

		const result = await authService.deleteUserAccount(userId, onlyAccountId);

		expect(result).toEqual({ lastAccount: true, notFound: false });

		const existingAccount = await db.query.account.findFirst({
			where: { id: onlyAccountId },
			columns: { id: true },
		});

		expect(existingAccount).toEqual({ id: onlyAccountId });
	});

	test("removeOrgMember rehomes active sessions to another organization membership", async () => {
		const userId = await createUser(`${randomSlug("user")}@example.com`);
		const removedOrgId = await createOrganization("Removed Org");
		const fallbackOrgId = await createOrganization("Fallback Org");
		const membershipId = await createMembership({
			userId,
			organizationId: removedOrgId,
			role: "member",
		});
		await createMembership({
			userId,
			organizationId: fallbackOrgId,
			role: "member",
		});
		await createSession({ userId, activeOrganizationId: removedOrgId });

		const result = await authService.removeOrgMember(membershipId, removedOrgId);

		expect(result).toEqual({ found: true, isOwner: false });

		const session = await db.query.sessionsTable.findFirst({
			where: { userId },
			columns: { activeOrganizationId: true },
		});
		const removedMembership = await db.query.member.findFirst({
			where: { id: membershipId },
			columns: { id: true },
		});

		expect(session?.activeOrganizationId).toBe(fallbackOrgId);
		expect(removedMembership).toBeUndefined();
	});

	test("removeOrgMember revokes sessions when the removed user has no fallback organization", async () => {
		const userId = await createUser(`${randomSlug("user")}@example.com`);
		const removedOrgId = await createOrganization("Removed Org");
		const membershipId = await createMembership({
			userId,
			organizationId: removedOrgId,
			role: "member",
		});
		await createSession({ userId, activeOrganizationId: removedOrgId });

		const result = await authService.removeOrgMember(membershipId, removedOrgId);

		expect(result).toEqual({ found: true, isOwner: false });

		const remainingSessions = await db.query.sessionsTable.findMany({
			where: { userId },
			columns: { id: true },
		});
		const removedMembership = await db.query.member.findFirst({
			where: { id: membershipId },
			columns: { id: true },
		});

		expect(remainingSessions).toHaveLength(0);
		expect(removedMembership).toBeUndefined();
	});

	test("removeOrgMember returns isOwner=true and does not remove owner membership", async () => {
		const userId = await createUser(`${randomSlug("user")}@example.com`);
		const orgId = await createOrganization("Owner Org");
		const membershipId = await createMembership({
			userId,
			organizationId: orgId,
			role: "owner",
		});

		const result = await authService.removeOrgMember(membershipId, orgId);

		expect(result).toEqual({ found: true, isOwner: true });

		const existingMembership = await db.query.member.findFirst({
			where: { id: membershipId },
			columns: { id: true, role: true },
		});

		expect(existingMembership).toEqual({ id: membershipId, role: "owner" });
	});

	test("removeOrgMember returns found=false for missing membership and leaves members/sessions unchanged", async () => {
		const userId = await createUser(`${randomSlug("user")}@example.com`);
		const orgId = await createOrganization("Existing Org");
		const otherOrgId = await createOrganization("Other Org");
		const membershipId = await createMembership({
			userId,
			organizationId: orgId,
			role: "member",
		});
		await createMembership({
			userId,
			organizationId: otherOrgId,
			role: "member",
		});
		await createSession({ userId, activeOrganizationId: orgId });

		const membersBefore = await db.query.member.findMany({
			where: { userId },
			columns: { id: true },
		});
		const sessionsBefore = await db.query.sessionsTable.findMany({
			where: { userId },
			columns: { id: true, activeOrganizationId: true },
		});

		const result = await authService.removeOrgMember(randomId(), orgId);

		expect(result).toEqual({ found: false, isOwner: false });

		const membersAfter = await db.query.member.findMany({
			where: { userId },
			columns: { id: true },
		});
		const sessionsAfter = await db.query.sessionsTable.findMany({
			where: { userId },
			columns: { id: true, activeOrganizationId: true },
		});
		const membershipStillExists = await db.query.member.findFirst({
			where: { id: membershipId },
			columns: { id: true },
		});

		expect(membersAfter).toEqual(membersBefore);
		expect(sessionsAfter).toEqual(sessionsBefore);
		expect(membershipStillExists).toEqual({ id: membershipId });
	});
});
