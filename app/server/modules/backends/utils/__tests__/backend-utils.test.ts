import * as fs from "node:fs/promises";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as mountinfo from "../../../../utils/mountinfo";
import { assertMounted } from "../backend-utils";

afterEach(() => {
	mock.restore();
});

describe("assertMountedFilesystem", () => {
	test("throws when the path is not accessible", async () => {
		spyOn(fs, "access").mockRejectedValueOnce(new Error("missing"));

		await expect(assertMounted("/tmp/volume", (fstype) => fstype.startsWith("nfs"))).rejects.toThrow(
			"Volume is not mounted",
		);
	});

	test("throws when the mount filesystem does not match", async () => {
		spyOn(fs, "access").mockResolvedValueOnce(undefined);
		spyOn(mountinfo, "getMountForPath").mockResolvedValueOnce({
			mountPoint: "/tmp/volume",
			fstype: "cifs",
		});

		await expect(assertMounted("/tmp/volume", (fstype) => fstype.startsWith("nfs"))).rejects.toThrow(
			"Path /tmp/volume is not mounted as correct fstype (found cifs).",
		);
	});

	test("accepts a matching mounted filesystem", async () => {
		spyOn(fs, "access").mockResolvedValueOnce(undefined);
		spyOn(mountinfo, "getMountForPath").mockResolvedValueOnce({
			mountPoint: "/tmp/volume",
			fstype: "nfs4",
		});

		await expect(assertMounted("/tmp/volume", (fstype) => fstype.startsWith("nfs"))).resolves.toBeUndefined();
	});
});
